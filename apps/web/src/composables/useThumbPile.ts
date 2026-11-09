import type { Ref, WatchSource } from 'vue'
import { onScopeDispose, reactive, ref, watch } from 'vue'

/**
 * The fading "messy pile" of selected thumbnails in the multi-select panel.
 *
 * Bypasses TransitionGroup so each thumb fades on its own delay (driven by
 * its z-layer, not its v-for position). Each displayed thumb carries an
 * explicit lifecycle — `opacity` is only what is painted:
 *
 *   entering ──(enterDelay)──▶ shown ──deselect──▶ leaving ──(leaveDelay + duration)──▶ removed
 *      │                          ▲                   │
 *      └──────── deselect ────────┼──────────────────▶│
 *                                 └──── reselect ─────┘ (fades back in if it had faded)
 *
 * Every transition cancels the thumb's pending timers and frames first, so a
 * stale callback from an earlier phase can never fade out (or remove) a thumb
 * that was reselected, or fade in one that was deselected.
 */
export type ThumbPhase = 'entering' | 'shown' | 'leaving'

export interface ThumbTiming {
  enterDelay: number
  leaveDelay: number
  duration: number
}

export interface DisplayedThumb<P> {
  id: number
  post: P
  idx: number
  phase: ThumbPhase
  /** Painted opacity (CSS transitions between 0 and 1 over `duration`). */
  opacity: 0 | 1
  duration: number
}

/** Extra wait after a fade-out before the thumb is removed from the list. */
const REMOVE_SLACK_MS = 40

export function useThumbPile<P extends { id: number }>(
  source: WatchSource<P[]>,
  timingOf: (id: number, idx: number) => ThumbTiming,
): Ref<DisplayedThumb<P>[]> {
  const displayed = ref([]) as Ref<DisplayedThumb<P>[]>
  const pending = new Map<number, { timeouts: ReturnType<typeof setTimeout>[], frames: number[] }>()

  function cancel(id: number) {
    const handles = pending.get(id)
    if (handles) {
      for (const t of handles.timeouts) {
        clearTimeout(t)
      }
      for (const f of handles.frames) {
        cancelAnimationFrame(f)
      }
    }
    pending.delete(id)
  }

  function handlesOf(id: number) {
    let handles = pending.get(id)
    if (!handles) {
      handles = { timeouts: [], frames: [] }
      pending.set(id, handles)
    }
    return handles
  }

  function later(id: number, ms: number, fn: () => void) {
    handlesOf(id).timeouts.push(setTimeout(fn, ms))
  }

  // The rAF guarantees the browser paints the previous opacity once before
  // the new value lands; otherwise Vue may batch 0 → 1 into one frame and the
  // transition is silently dropped.
  function laterPainted(id: number, ms: number, fn: () => void) {
    later(id, ms, () => {
      handlesOf(id).frames.push(requestAnimationFrame(fn))
    })
  }

  function enter(item: DisplayedThumb<P>, timing: ThumbTiming) {
    cancel(item.id)
    item.phase = 'entering'
    item.duration = timing.duration
    laterPainted(item.id, timing.enterDelay, () => {
      item.opacity = 1
      item.phase = 'shown'
    })
  }

  function leave(item: DisplayedThumb<P>, timing: ThumbTiming) {
    cancel(item.id)
    item.phase = 'leaving'
    item.duration = timing.duration
    laterPainted(item.id, timing.leaveDelay, () => {
      item.opacity = 0
    })
    later(item.id, timing.leaveDelay + timing.duration + REMOVE_SLACK_MS, () => {
      cancel(item.id)
      const i = displayed.value.findIndex(x => x.id === item.id)
      if (i !== -1) {
        displayed.value.splice(i, 1)
      }
    })
  }

  watch(source, (next) => {
    const nextIds = new Set(next.map(p => p.id))
    const idxOf = new Map(next.map((p, i) => [p.id, i]))

    for (const [idx, post] of next.entries()) {
      const existing = displayed.value.find(d => d.id === post.id)
      if (!existing) {
        // reactive() up front: the timers mutate this object, and must hit
        // the proxy (a raw object pushed into a ref'd array would not).
        const item = reactive({
          id: post.id,
          post,
          idx,
          phase: 'entering',
          opacity: 0,
          duration: 0,
        }) as DisplayedThumb<P>
        displayed.value.push(item)
        enter(item, timingOf(post.id, idx))
        continue
      }
      existing.idx = idx
      existing.post = post
      if (existing.phase === 'leaving') {
        if (existing.opacity === 1) {
          // Its fade-out had not started yet: just keep it.
          cancel(existing.id)
          existing.phase = 'shown'
        }
        else {
          enter(existing, timingOf(post.id, idx))
        }
      }
    }

    for (const d of displayed.value) {
      if (!nextIds.has(d.id) && d.phase !== 'leaving') {
        leave(d, timingOf(d.id, idxOf.get(d.id) ?? d.idx))
      }
    }
  }, { immediate: true })

  onScopeDispose(() => {
    for (const id of pending.keys()) {
      cancel(id)
    }
  })

  return displayed
}
