import type { QueryClient } from '@tanstack/vue-query'
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import type { QueueSummaryPublic } from '@/api'
import { computed, onMounted, ref, toValue, watch } from 'vue'
import { formatNumber, i18n } from '@/locale'
import { removeEntries } from '@/shared/annotationTimeline'
import { announce } from '@/shared/announce'
import { pushCommand } from '@/shared/history'
import { undoAnnotations } from '@/shared/mutations'
import { useHotkey } from '@/ui/useHotkey'
import { focusElement } from '@/utils/focus'
import { isForeignComposite, noLayerOpen, useProgressAnnouncer } from './useAnnotationKeymap'

/**
 * The judging loop the three annotation sessions (absolute / pairwise / listwise)
 * share: a buffer of things to judge that refills itself in the background, the
 * session's progress count, and the undo contract for a submitted judgement.
 *
 * What stays in each session is what is actually different: what one item is,
 * how it is fetched and submitted, and its UI. The numbers below (water marks,
 * empty-batch tolerance, preload depth) are per-session options because they
 * were tuned per session — see the call sites for why each one is what it is.
 */

/** Every buffered item may carry its queue position (queue mode only). */
export interface StreamItem { position?: number }

export type AnnotationKind = 'absolute' | 'pairwise' | 'listwise'

/**
 * Where the background refill stands. `loading` is also the one-at-a-time gate;
 * `error` is a failed batch (the session offers a retry when nothing is left on
 * screen, and the next refill tries again on its own); `exhausted` means the
 * server ran dry and refill stops asking until an undo / reset brings items back.
 */
export type StreamLoadState = 'ready' | 'loading' | 'error' | 'exhausted'

export interface AnnotationStreamOptions<T extends StreamItem> {
  /** Event kind: the undo endpoint's `kind` and the history list's entry kind. */
  kind: AnnotationKind
  queryClient: QueryClient
  /** Per-session id stamped on every event and undo. */
  sessionId: string
  /** The fixed queue being worked through, or undefined for streamed sampling. */
  queue: MaybeRefOrGetter<QueueSummaryPublic | undefined>
  /** One batch from the server (queue: next items; stream: a fresh sample). */
  fetchBatch: () => Promise<T[]>
  /**
   * Identity for de-duplication. In queue mode an item is dropped only when the
   * same key is already in the buffer (queue items are keyed by position); in
   * stream mode a key is shown at most once per session.
   */
  keyOf: (item: T) => string
  /** Refill when the buffer drops below this many items. */
  lowWater: number
  /**
   * Consecutive empty batches that mean "nothing left". Below it an empty batch
   * is retried at once, as part of the same refill.
   */
  emptyLimit: number
  /** Warm the next `ahead` items (after the current one) with `preload`. */
  preload: { ahead: number, item: (item: T) => void }
  /** A batch failed to load. */
  onLoadError: (error: unknown) => void
  /** Progress copy for streamed sampling (queue mode uses the shared queue copy). */
  streamProgress: { labelKey: string, announceKey: string }
  /** The posts an item is about — their per-post history is refreshed on undo. */
  postIdsOf: (item: T) => number[]
}

export interface UndoableJudgement<T> {
  item: T
  /** Event ids the judgement wrote (empty is fine: a queue skip writes none). */
  ids: number[]
  label: string
  /** Redo: write the judgement again and resolve to the NEW event ids. */
  redo: () => Promise<number[]>
  /**
   * Undo puts the item back on screen only while this holds (e.g. the session is
   * still on the dimension it was judged in). The events are deleted regardless.
   */
  stillHere?: () => boolean
  /** Session-specific restoration once the item is back at the head of the buffer. */
  onRevert?: () => void
}

export interface AnnotationStream<T extends StreamItem> {
  buffer: Ref<T[]>
  /** The item being judged (head of the buffer). */
  current: ComputedRef<T | null>
  doneCount: Ref<number>
  loadState: Readonly<Ref<StreamLoadState>>
  /** Shorthand for `loadState === 'exhausted'`. */
  exhausted: ComputedRef<boolean>
  submitting: Ref<boolean>
  /** "n done" / "done / total" for the session header. */
  progressLabel: ComputedRef<string>
  /**
   * Refill in the background if below the low-water mark (gated: one at a
   * time). Also the session's Retry after a failed batch.
   */
  refill: () => Promise<void>
  /** Drop the head item: count it, re-arm the timer, preload, refill, announce. */
  advance: () => void
  /** Milliseconds since the current item was put on screen. */
  elapsedMs: () => number
  /** Restart the per-item timer. */
  markShown: () => void
  /** Warm the images of the next few items. */
  preloadAhead: () => void
  /** Stream mode: mark a key as shown / forget it (local skip and its undo). */
  remember: (key: string) => void
  forget: (key: string) => void
  /** Put an item back at the head of the buffer (undo); clears `exhausted`. */
  putBack: (item: T) => void
  /** Start over (new queue / config): empty buffer, forget everything, refill. */
  reset: () => void
  /**
   * Run `work` on the current item with the in-flight flag held; no-op without
   * an item or while another submit runs. A failure is reported via `onError`.
   */
  submitCurrent: (work: (item: T) => Promise<void>, onError: (error: unknown) => void) => Promise<void>
  /**
   * Push a submitted judgement onto the global undo stack. Undo really deletes
   * the event rows (a slip would otherwise land in the training export, and the
   * sampler would consider the pair asked), drops them from the history list and
   * puts the item back on screen; redo writes it again.
   *
   * pushCommand, not mutations.ts's record(): record() pops the snackbar every
   * time, and here a judgement lands every second or so. Undo pops it itself.
   */
  pushUndoable: (judgement: UndoableJudgement<T>) => void
}

export function useAnnotationStream<T extends StreamItem>(options: AnnotationStreamOptions<T>): AnnotationStream<T> {
  const { kind, queryClient, sessionId, fetchBatch, keyOf, lowWater, emptyLimit, preload, onLoadError, postIdsOf } = options
  const t = i18n.global.t

  const queue = () => toValue(options.queue)
  const buffer = ref<T[]>([]) as Ref<T[]>
  const current = computed(() => buffer.value[0] ?? null)
  const doneCount = ref(queue()?.done ?? 0)
  const loadState = ref<StreamLoadState>('ready')
  const exhausted = computed(() => loadState.value === 'exhausted')
  const submitting = ref(false)

  // Queue mode counts against the queue's total with the shared queue copy;
  // stream mode has no total and uses the session's own copy.
  function progressText(queueKey: string, streamKey: string): string {
    const q = queue()
    const done = formatNumber(doneCount.value)
    return q
      ? t(queueKey, { done, total: formatNumber(q.total) })
      : t(streamKey, { n: done })
  }
  const progressLabel = computed(() => progressText('annotate.progress.queue', options.streamProgress.labelKey))
  const announceProgress = useProgressAnnouncer(() => progressText('annotate.progress.queueAnnounce', options.streamProgress.announceKey))

  const seenKeys = new Set<string>()
  let shownAt = performance.now()
  // Bumped by reset(): a refill started before it belongs to the old queue /
  // config, so its batch is dropped and it leaves loadState to the new refill.
  let generation = 0

  function markShown() {
    shownAt = performance.now()
  }

  function elapsedMs() {
    return Math.round(performance.now() - shownAt)
  }

  function preloadAhead() {
    for (const item of buffer.value.slice(1, 1 + preload.ahead)) {
      preload.item(item)
    }
  }

  function dedupe(batch: T[]): T[] {
    if (queue()) {
      const known = new Set(buffer.value.map(keyOf))
      return batch.filter(item => !known.has(keyOf(item)))
    }
    return batch.filter((item) => {
      const key = keyOf(item)
      if (seenKeys.has(key)) {
        return false
      }
      seenKeys.add(key)
      return true
    })
  }

  async function refill(): Promise<void> {
    // refill is not awaited on the key path, so it can be triggered twice at once.
    // Without the `loading` gate both requests de-duplicate against each other and
    // come back empty, which reads as "exhausted".
    if (loadState.value === 'loading' || loadState.value === 'exhausted' || buffer.value.length >= lowWater) {
      return
    }
    const gen = generation
    loadState.value = 'loading'
    try {
      // One empty batch is not the end: a sampler that seeds from a few random
      // posts can draw only already-judged ones. Give up after `emptyLimit` in a row.
      for (let empty = 0; ;) {
        const batch = await fetchBatch()
        if (gen !== generation) {
          return
        }
        const fresh = dedupe(batch)
        buffer.value.push(...fresh)
        if (fresh.length > 0) {
          loadState.value = 'ready'
          break
        }
        empty += 1
        if (empty >= emptyLimit) {
          loadState.value = 'exhausted'
          break
        }
      }
      preloadAhead()
    }
    catch (error) {
      if (gen !== generation) {
        return
      }
      loadState.value = 'error'
      onLoadError(error)
    }
  }

  function putBack(item: T) {
    buffer.value.unshift(item)
    if (loadState.value === 'exhausted') {
      loadState.value = 'ready' // judging the last item set it; there is one again
    }
  }

  function advance() {
    buffer.value.shift()
    doneCount.value += 1
    markShown()
    preloadAhead()
    // Not awaited: sampling can take seconds (vec0 KNN), and awaiting it would put
    // that delay between the key press and the next item. The buffer still holds
    // `lowWater` items to judge meanwhile.
    void refill()
    announceProgress()
  }

  function reset() {
    generation += 1
    buffer.value = []
    seenKeys.clear()
    loadState.value = 'ready'
    doneCount.value = queue()?.done ?? 0
    markShown()
    void refill()
  }

  async function submitCurrent(work: (item: T) => Promise<void>, onError: (error: unknown) => void) {
    const item = current.value
    if (!item || submitting.value) {
      return
    }
    submitting.value = true
    try {
      await work(item)
    }
    catch (error) {
      onError(error)
    }
    finally {
      submitting.value = false
    }
  }

  function pushUndoable(judgement: UndoableJudgement<T>) {
    const { item, label, redo, stillHere, onRevert } = judgement
    // Redo is a fresh INSERT: keep its ids, or the next undo would delete rows
    // that no longer exist and leave the redone one in the database.
    let eventIds = judgement.ids
    pushCommand({
      label,
      // Empty = leave the gallery selection alone: the item itself comes back on
      // screen, and changing a selection behind a full-screen session is invisible.
      postIds: [],
      apply: async () => {
        eventIds = await redo()
      },
      revert: async () => {
        await undoAnnotations(queryClient, {
          kind,
          ids: eventIds,
          sessionId,
          queueId: queue()?.id ?? null,
          queuePosition: item.position ?? null,
        }, postIdsOf(item))
        removeEntries(queryClient, kind, eventIds) // the events are gone; so is their history row
        if (stillHere && !stillHere()) {
          return
        }
        putBack(item)
        doneCount.value = Math.max(0, doneCount.value - 1)
        onRevert?.()
        markShown()
      },
    })
  }

  return {
    buffer,
    current,
    doneCount,
    loadState,
    exhausted,
    submitting,
    progressLabel,
    refill,
    advance,
    elapsedMs,
    markShown,
    preloadAhead,
    remember: key => seenKeys.add(key),
    forget: key => seenKeys.delete(key),
    putBack,
    reset,
    submitCurrent,
    pushUndoable,
  }
}

/**
 * The session frame the three sessions share: Escape backs out (layers swallow it
 * first), focus lands on the session when the launcher that started it is gone,
 * and running dry is announced once. Returns the `ignore` guard that keeps
 * session hotkeys out of other components' composite widgets.
 */
export function useAnnotationSessionFrame(options: {
  root: Readonly<Ref<HTMLElement | null>>
  onEscape: () => void
  /** True once the stream is exhausted and nothing is left on screen. */
  finished: () => boolean
}): { notForeign: (e: KeyboardEvent) => boolean } {
  const { root, onEscape, finished } = options
  const notForeign = (e: KeyboardEvent) => isForeignComposite(e.target, root.value)

  useHotkey('Escape', onEscape, { when: noLayerOpen, allowInWidgets: true, ignore: notForeign })

  // The start button / queue row that launched the session is gone; keep focus
  // off <body> so screen readers land on the session.
  onMounted(() => {
    const active = document.activeElement
    if (!active || active === document.body) {
      focusElement(root.value, { preventScroll: true })
    }
  })

  watch(finished, (done) => {
    if (done) {
      announce(i18n.global.t('annotate.session.exhaustedAnnounce'))
    }
  })

  return { notForeign }
}
