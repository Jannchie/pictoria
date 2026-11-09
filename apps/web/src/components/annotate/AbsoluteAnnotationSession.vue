<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import type { AbsoluteStrategy, AnnotationDimension, AnnotationScale, ContentFlag } from '@/shared/annotationTypes'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2NextAbsolute, v2SampleAbsolute } from '@/api'
import AnnotationChoiceGroup from '@/components/annotate/AnnotationChoiceGroup.vue'
import AnnotationKeyHints from '@/components/annotate/AnnotationKeyHints.vue'
import AnnotationLoadError from '@/components/annotate/AnnotationLoadError.vue'
import AnnotationReviewBanner from '@/components/annotate/AnnotationReviewBanner.vue'
import { choiceBindings, KEY_ROWS, noLayerOpen } from '@/composables/useAnnotationKeymap'
import { useAnnotationReview } from '@/composables/useAnnotationReview'
import { useAnnotationSessionFrame, useAnnotationStream } from '@/composables/useAnnotationStream'
import { useAPIError } from '@/composables/useAPIError'
import { preloadImage } from '@/composables/usePostPrefetch'
import { formatNumber } from '@/locale'
import { endReview, flagGlyph, prependEntry, pushCommand, submitAbsolute, submitContentFlag } from '@/shared'
import { dimensionMeta } from '@/shared/annotationTypes'
import { useHotkey } from '@/ui/useHotkey'
import { getPostImageURL } from '@/utils'
import { matchesShortcut, shortcutKeys } from '@/utils/keyboard'

export interface StreamConfig {
  dimensions: AnnotationDimension[]
  scale: AnnotationScale
  strategy: AbsoluteStrategy
}

interface BufferItem {
  post: QueueItemPostPublic
  position?: number // queue 模式才有
}

// queue 与 config 二选一：有 queue 走固定批次，否则走无队列流式采样。
const props = defineProps<{ queue?: QueueSummaryPublic, config?: StreamConfig }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()
const { t } = useI18n()
const queryClient = useQueryClient()

const sessionId = crypto.randomUUID()
const dimensions = computed(() => props.queue?.dimensions ?? props.config?.dimensions ?? [])
const scale = computed(() => props.queue?.scale ?? props.config?.scale ?? 2)
const rubricVersions = computed(() => Object.fromEntries(dimensions.value.map(d => [d, `${d}-v1`])))

function postURL(p: QueueItemPostPublic) {
  return getPostImageURL(p)
}

// stream 模式：本会话内跳过/已出过的图不再入 buffer（key = post id）。
function keyOf(item: BufferItem): string {
  return item.position == null ? `p${item.post.id}` : `q${item.position}`
}

const stream = useAnnotationStream<BufferItem>({
  kind: 'absolute',
  queryClient,
  sessionId,
  queue: () => props.queue,
  async fetchBatch() {
    if (props.queue) {
      const resp = await v2NextAbsolute({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
      return (resp.data ?? []).map(i => ({ post: i.post, position: i.position }))
    }
    const resp = await v2SampleAbsolute({
      query: { dimensions: dimensions.value, strategy: props.config?.strategy ?? 'random', limit: 20 },
    })
    return (resp.data ?? []).map(p => ({ post: p }))
  },
  keyOf,
  // 见 PairwiseAnnotationSession：低于水位就后台补货。单图采样比对比采样便宜
  // （~200ms，不走 KNN），但同样不该卡在按键路径上。
  lowWater: 10,
  // 一次空响应即收摊、不重试（沿用单图评分一直以来的行为；对比采样才容忍一次空批）。
  emptyLimit: 1,
  // 预热 buffer 中接下来几张的原图：标注当前图的几秒钟里，下一张已进
  // 浏览器缓存，切图即显示（同 useAdjacentPostPrefetch 的思路）。
  preload: { ahead: 3, item: item => preloadImage(postURL(item.post)) },
  onLoadError: error => handleAPIError(error, t('annotate.error.loadImages')),
  streamProgress: { labelKey: 'annotate.progress.absolute', announceKey: 'annotate.progress.absoluteAnnounce' },
  postIdsOf: item => [item.post.id],
})
const { buffer, doneCount, exhausted, loadState, submitting, current } = stream
const totalLabel = stream.progressLabel
const { review, amend } = useAnnotationReview({ kind: 'absolute', field: 'value', labelKey: 'history.annotatePost', submitting })
// The picture on screen, and the dimensions to ask about. A record is ONE
// (post, dimension) event, so reviewing narrows the panel to that one row rather
// than re-asking every dimension the session was configured with.
const shownPost = computed(() => review.value?.post ?? current.value?.post)
const shownDimensions = computed(() => (review.value?.dimension ? [review.value.dimension] : dimensions.value))
const shownScale = computed(() => review.value?.scale ?? scale.value)
const choices = ref<Record<string, number>>({})
const flagState = ref<ContentFlag>('none')
// Bumped by every flag press and every item change: only the newest press may
// roll the optimistic flag back, and never onto another item.
let flagSeq = 0
const elapsed = ref<Record<string, number>>({})

function resetForNext() {
  choices.value = {}
  elapsed.value = {}
  flagState.value = 'none'
  flagSeq += 1
  stream.markShown()
}

function advance() {
  resetForNext()
  stream.advance() // 后台补货，别让采样延迟卡住翻页
}

/**
 * 把这一张压进全局撤销栈，Ctrl+Z 收回手滑的那几下（契约见 useAnnotationStream）。
 * 队列项撤销后也会重新打开，才能再标一次。
 *
 * ids 为空是合法的：跳过一张只标 done、不写事件，撤销就只是把 done 撤掉。
 * 题材 flag 不进撤销栈：'none' 本来就是它自己的撤回，且它是另一条事件流。
 */
function recordItem(item: BufferItem, ids: number[], label: string, redo: () => Promise<number[]>) {
  const restore = { choices: choices.value, elapsed: elapsed.value, flag: flagState.value }
  stream.pushUndoable({
    item,
    ids,
    label,
    redo,
    onRevert: () => {
      // 把上一张的档位选择也还原，撤销后能看到当时按了什么、只改错的那一档。
      choices.value = restore.choices
      elapsed.value = restore.elapsed
      flagState.value = restore.flag
      flagSeq += 1
    },
  })
}

async function postAnnotation(item: BufferItem): Promise<number[]> {
  const dims = dimensions.value
  const ids = await submitAbsolute(queryClient, {
    events: dims.map(d => ({
      postId: item.post.id,
      dimension: d,
      scale: scale.value,
      value: choices.value[d],
      rubricVersion: rubricVersions.value[d],
      sessionId,
      elapsedMs: elapsed.value[d] ?? null,
    })),
    queueId: props.queue?.id ?? null,
    queuePosition: item.position ?? null,
  })
  // One history row per event, in the order they were written — the server returns
  // ids in the same order it received the events, so index i belongs to dims[i].
  for (const [i, id] of ids.entries()) {
    const dimension = dims[i]
    if (dimension) {
      prependEntry(queryClient, { kind: 'absolute', id, post: item.post, dimension, scale: scale.value, value: choices.value[dimension] })
    }
  }
  return ids
}

function submitAndAdvance() {
  return stream.submitCurrent(async (item) => {
    const ids = await postAnnotation(item)
    recordItem(item, ids, t('history.annotatePost'), async () => {
      const again = await postAnnotation(item)
      advance()
      return again
    })
    advance()
  }, error => handleAPIError(error, t('annotate.error.submit')))
}

// 选择一个档位（键盘与鼠标共用）：记录耗时，选满全部维度即提交翻页。
// 复判时同一个入口改落到那条记录上，键位和点击目标都不变。
function selectChoice(dimension: string, value: number) {
  if (review.value) {
    void amend(value)
    return
  }
  if (!current.value || submitting.value) {
    return
  }
  choices.value = { ...choices.value, [dimension]: value }
  elapsed.value = { ...elapsed.value, [dimension]: stream.elapsedMs() }
  if (dimensions.value.every(d => choices.value[d] != null)) {
    submitAndAdvance()
  }
}

// ── Keyboard ────────────────────────────────────────────────────────────────
// Every session key goes through useHotkey: exact modifiers (Ctrl+Z is undo, never
// the 'z' rating), nothing while typing, nothing while a layer (palette, help,
// dialog) is open, and nothing while focus is in someone else's composite widget.
const root = useTemplateRef<HTMLElement>('root')
// Esc leaves the review first, the session only when there is no review to leave.
// Layers (palette, help) swallow Escape before it gets here.
const { notForeign } = useAnnotationSessionFrame({
  root,
  onEscape: () => (review.value ? endReview() : emit('exit')),
  finished: () => exhausted.value && !current.value,
})

// 维度×档位按键：行 = 维度，列 = 档位。复判时面板收窄成一行，键位跟着屏幕走。
const bindings = computed(() => choiceBindings(shownDimensions.value, shownScale.value))
useHotkey(() => bindings.value.map(b => b.key), (e) => {
  const b = bindings.value.find(x => matchesShortcut(e, x.key))
  if (b) {
    selectChoice(b.dimension, b.value)
  }
}, { when: noLayerOpen, allowInWidgets: true, ignore: notForeign, repeat: false })

// 0 = 题材 flag 循环（事件流：每次按键都记录，'none' 即撤销）
async function cycleFlag() {
  if (!current.value) {
    return
  }
  const next = flagState.value === 'none' ? 'love' : flagState.value === 'love' ? 'hate' : 'none'
  const post = current.value.post
  const previous = flagState.value
  const seq = ++flagSeq
  flagState.value = next
  try {
    const ids = await submitContentFlag(queryClient, { postId: post.id, flag: next, sessionId })
    // Flags are the third stream in the history list and were the one that never
    // reached its head — they only appeared, mid-list, after a manual refresh.
    const id = ids[0]
    if (id != null) {
      prependEntry(queryClient, { kind: 'flag', id, post, flag: next })
    }
  }
  catch (error) {
    if (seq === flagSeq) {
      flagState.value = previous
    }
    handleAPIError(error, t('annotate.error.flag'))
  }
}
useHotkey('0', () => void cycleFlag(), {
  when: () => noLayerOpen() && !!current.value,
  allowInWidgets: true,
  ignore: notForeign,
  repeat: false,
})

// Space = 跳过整张图（queue：标 done 不发事件；stream：本会话内不再出现）
async function skipCurrent() {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  if (props.queue) {
    await stream.submitCurrent(async () => {
      const skipItem = async (): Promise<number[]> => {
        await submitAbsolute(queryClient, { events: [], queueId: props.queue!.id, queuePosition: item.position ?? null })
        advance()
        return [] // 跳过不写事件，只翻 done 标记
      }
      await skipItem()
      // 队列跳过没有事件行可删，撤销就是把队列项重新打开（ids 为空）。
      recordItem(item, [], t('history.skipPost'), skipItem)
    }, error => handleAPIError(error, t('annotate.error.skip')))
  }
  else {
    // 流式跳过完全不落库，撤销纯粹是本地的：把图放回去、别再被去重挡住。
    buffer.value.shift()
    resetForNext()
    stream.preloadAhead()
    void stream.refill()
    pushCommand({
      label: t('history.skipPost'),
      postIds: [],
      apply: async () => {
        buffer.value.shift()
        stream.remember(keyOf(item))
        resetForNext()
      },
      revert: async () => {
        stream.forget(keyOf(item))
        stream.putBack(item)
        resetForNext()
      },
    })
  }
}
// Space yields to a focused button (it activates it); the choice buttons never keep
// focus from a mouse click, so the usual click-then-Space rhythm still skips.
useHotkey('Space', () => void skipCurrent(), {
  when: () => noLayerOpen() && !!current.value && !submitting.value && !review.value,
  ignore: notForeign,
  repeat: false,
})

watch(() => [props.queue?.id, props.config] as const, () => {
  endReview()
  resetForNext()
  stream.reset()
}, { immediate: true })

const SCALE_LABEL_KEYS: Record<number, string[]> = {
  2: ['annotate.scale.notGood', 'annotate.scale.good'],
  3: ['annotate.scale.poor', 'annotate.scale.fair', 'annotate.scale.good'],
}
const labels = computed(() => {
  const keys = SCALE_LABEL_KEYS[shownScale.value]
  if (keys) {
    return keys.map(k => t(k))
  }
  return Array.from({ length: shownScale.value }, (_, i) => String(i + 1))
})
function dimensionLabel(d: string) {
  const meta = dimensionMeta(d)
  return meta ? t(meta.labelKey) : d
}
const title = computed(() => props.queue?.name
  ?? t('annotate.absolute.streamTitle', { dimensions: dimensions.value.map(dimensionLabel).join(' / ') }))

function choiceOptions(row: number) {
  return labels.value.map((label, i) => ({ label, key: KEY_ROWS[row]?.[i] ?? '' }))
}
const idBase = useId()

const hints = computed(() => [
  { keys: ['Space'], label: t('annotate.keys.skip') },
  { keys: ['0'], label: t('annotate.keys.flag') },
  { keys: shortcutKeys('Mod+Z'), label: t('annotate.keys.undo') },
  { keys: ['Esc'], label: t('annotate.keys.exit') },
])
</script>

<template>
  <div ref="root" class="annotate-session flex flex-col h-full" tabindex="-1" role="region" :aria-label="title">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button
          type="button"
          class="annotate-exit"
          :aria-label="$t('annotate.session.exit')"
          :title="$t('annotate.session.exitHint', { key: 'Esc' })"
          aria-keyshortcuts="Escape"
          @click="emit('exit')"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
        </button>
        <h2 class="text-fg font-medium truncate">
          {{ title }}
        </h2>
        <span role="status" class="text-xs shrink-0">
          <template v-if="flagState !== 'none'">
            <span aria-hidden="true">{{ flagGlyph(flagState) }}</span>
            {{ flagState === 'love' ? $t('annotate.absolute.flagLove') : $t('annotate.absolute.flagHate') }}
          </template>
        </span>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <AnnotationKeyHints :hints="hints" />
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <!-- 复判横幅：正在改哪一条 -->
      <AnnotationReviewBanner v-if="review" :verdict="`${review.value} / ${review.scale}`" @exit="endReview()" />

      <div v-if="shownPost" class="flex flex-1 min-h-0">
        <!-- 图片区 -->
        <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
          <img
            :key="shownPost.id"
            :src="postURL(shownPost)"
            :alt="shownPost.fileName"
            class="max-h-full max-w-full object-contain"
            decoding="async"
          >
        </div>

        <!-- 判断面板 -->
        <div class="px-4 py-5 border-l border-border-subtle flex shrink-0 flex-col gap-4 w-72 overflow-y-auto">
          <div
            v-for="(dim, row) in shownDimensions"
            :key="dim"
            class="annotate-judge-card"
            :class="{ 'annotate-judge-card--done': !review && choices[dim] != null }"
          >
            <div class="flex gap-2 items-center">
              <i :class="dimensionMeta(dim)?.icon" class="annotate-judge-card__icon" aria-hidden="true" />
              <span :id="`${idBase}-dim-${row}`" class="text-sm text-fg font-medium">{{ dimensionLabel(dim) }}</span>
            </div>
            <p v-if="dimensionMeta(dim)" class="text-xs text-fg-muted leading-relaxed mt-1">
              {{ $t(dimensionMeta(dim)!.promptKey) }}
            </p>
            <AnnotationChoiceGroup
              :labelledby="`${idBase}-dim-${row}`"
              :options="choiceOptions(row)"
              :checked="review ? Number(review.value) : choices[dim]"
              @select="selectChoice(dim, $event)"
            />
          </div>
        </div>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3" aria-hidden="true">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            {{ $t('annotate.absolute.exhausted') }}
          </div>
          <i18n-t keypath="annotate.absolute.exhaustedDetail" tag="div" scope="global" class="text-xs text-fg-muted mt-1">
            <template #n>
              {{ formatNumber(doneCount) }}
            </template>
            <template #esc>
              <kbd class="annotate-kbd-inline">Esc</kbd>
            </template>
          </i18n-t>
        </div>
        <AnnotationLoadError v-else-if="loadState === 'error'" @retry="stream.refill()" />
        <div v-else role="status" class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="annotate-spinner" aria-hidden="true" />{{ $t('common.loading') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.annotate-exit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--p-radius-sm);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition: background-color var(--p-transition-fast), color var(--p-transition-fast);
}
.annotate-exit:hover {
  background: rgb(var(--p-primary-rgb) / 0.12);
  color: var(--p-fg);
}

.annotate-session:focus {
  outline: none;
}

.annotate-kbd-inline {
  display: inline-block;
  padding: 1px 5px;
  margin: 0 1px;
  font-family: var(--p-font-mono);
  font-size: 10px;
  border: 1px solid var(--p-border);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: var(--p-fg-muted);
}

/* 判断卡片 */
.annotate-judge-card {
  padding: 13px 14px;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-lg);
  transition: border-color var(--p-transition-fast), opacity var(--p-transition-fast);
}
.annotate-judge-card--done {
  opacity: 0.62;
}
.annotate-judge-card:not(.annotate-judge-card--done) {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
}
.annotate-judge-card__icon {
  color: var(--p-primary);
  font-size: 15px;
}

.annotate-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--p-border);
  border-top-color: var(--p-primary);
  border-radius: 50%;
  animation: annotate-spin 0.7s linear infinite;
}
@keyframes annotate-spin {
  to { transform: rotate(360deg); }
}
</style>
