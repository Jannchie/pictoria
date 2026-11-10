<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import type { AnnotationDimension, PairwiseStrategy, PairwiseWinner } from '@/shared/annotationTypes'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2CountPairwise, v2NextPairwise, v2SamplePairwise } from '@/api'
import AnnotationKeyHints from '@/components/annotate/AnnotationKeyHints.vue'
import AnnotationLoadError from '@/components/annotate/AnnotationLoadError.vue'
import AnnotationReviewBanner from '@/components/annotate/AnnotationReviewBanner.vue'
import { noLayerOpen } from '@/composables/useAnnotationKeymap'
import { useAnnotationReview } from '@/composables/useAnnotationReview'
import { useAnnotationSessionFrame, useAnnotationStream } from '@/composables/useAnnotationStream'
import { useAPIError } from '@/composables/useAPIError'
import { preloadImage } from '@/composables/usePostPrefetch'
import { formatNumber } from '@/locale'
import { endReview, prependEntry, submitPairwise, winnerLabel } from '@/shared'
import { dimensionMeta } from '@/shared/annotationTypes'
import { useHotkey } from '@/ui/useHotkey'
import { getPostImageURL } from '@/utils'
import { shortcutKeys } from '@/utils/keyboard'

interface BufferItem {
  postA: QueueItemPostPublic
  postB: QueueItemPostPublic
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则按 dimension 流式采样。
// strategy 仅流式有效：close = 视觉相近且模型分不开的边界对，并自动接上已标过的比较图（默认）；
// similar = 内容相似 + 旧分相近（不参考模型，留作评估）；random = 全库随机。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: AnnotationDimension, strategy?: PairwiseStrategy }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()
const { t } = useI18n()
const queryClient = useQueryClient()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'overall')
// 采样来源要跟着判决一起落库：close 是训练燃料，random / similar 才是与模型无关、能当
// 留出评估的。不记下来，事后就再也分不出哪条是哪条（2026-08-20 之前的 5430 条就是这么
// 丢掉评估集的）。队列模式下策略是队列的属性，从摘要拿。
//
// 只报**请求**的采样方式就够了 —— 服务端会自己认出哪些其实是重复测量（见
// isRepeatMeasurement），那是客户端无法核实、也就不该保管的事实。
// 采样和提交读同一个值，两边的默认值不会漂。
const strategy = computed(() => props.queue?.strategy ?? props.strategy ?? 'close')

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL(p)
}

const stream = useAnnotationStream<BufferItem>({
  kind: 'pairwise',
  queryClient,
  sessionId,
  queue: () => props.queue,
  async fetchBatch() {
    if (props.queue) {
      const resp = await v2NextPairwise({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
      return (resp.data ?? []).map(i => ({ postA: i.postA, postB: i.postB, position: i.position }))
    }
    const resp = await v2SamplePairwise({ query: { limit: 20, strategy: strategy.value } })
    return (resp.data ?? []).map(p => ({ postA: p.postA, postB: p.postB }))
  },
  // 与左右无关的键：呈现顺序现在是随机翻转的，用有序键的话同一对换个朝向就漏过去了。
  keyOf: i => (i.position == null ? [i.postA.id, i.postB.id].sort((x, y) => x - y).join('-') : `q${i.position}`),
  // 补货水位：「低于这么多就去补」，不是「补到这么多」——后端一次给 20 条。
  // 取 10 而非 5，是因为流式采样要跑 vec0 KNN（214k 图暴力扫，一次邻域 ~0.9s；
  // 实测一批 20 对 close ≈ 1.2s、similar ≈ 3.5s）。水位越低，越可能在 buffer
  // 见底、用户已经无图可判时才补上。
  lowWater: 10,
  // 一次空响应不等于标完了：close 每次只抽几个种子，可能刚好都已经比够或没有模型分。
  // 连续两次空才收摊，否则会在还剩十万张图的时候弹「没有更多了」。
  emptyLimit: 2,
  // 预热接下来几对的原图：判断当前对的几秒钟里，下一对已进浏览器缓存。
  preload: {
    ahead: 2,
    item: (item) => {
      preloadImage(imgURL(item.postA))
      preloadImage(imgURL(item.postB))
    },
  },
  onLoadError: error => handleAPIError(error, t('annotate.error.loadImages')),
  streamProgress: { labelKey: 'annotate.progress.pairwise', announceKey: 'annotate.progress.pairwiseAnnounce' },
  postIdsOf: item => [item.postA.id, item.postB.id],
})
const { doneCount, exhausted, loadState, submitting, current } = stream

// 该维度数据库累计已判（decisive + tie，skip 不计）；流式模式下顶栏展示进度感。
const cumulativeCount = ref<number | null>(null)
const totalLabel = computed(() => {
  if (props.queue || cumulativeCount.value == null) {
    return stream.progressLabel.value
  }
  return `${stream.progressLabel.value} · ${t('annotate.progress.cumulative', { n: formatNumber(cumulativeCount.value) })}`
})

async function refreshCumulative() {
  try {
    const resp = await v2CountPairwise({ query: { dimension: dimension.value } })
    cumulativeCount.value = resp.data?.total ?? 0
  }
  catch {
    // 计数非关键，失败静默，不打断标注
  }
}
const { review, amend } = useAnnotationReview({ kind: 'pairwise', field: 'winner', labelKey: 'history.judgePair', submitting })

// What the two panes show. Reviewing borrows the whole judging surface rather than
// opening a second one — the decision is identical, so the keys, the click targets
// and the picture size should be too. Only where the verdict LANDS changes.
const shown = computed(() => {
  const r = review.value
  return r?.postB ? { postA: r.post, postB: r.postB } : current.value
})

function postJudgement(item: BufferItem, winner: PairwiseWinner, elapsedMs: number): Promise<number[]> {
  return submitPairwise(queryClient, {
    postA: item.postA.id,
    postB: item.postB.id,
    dimension: dimension.value,
    winner,
    rubricVersion: `${dimension.value}-v1`,
    sessionId,
    elapsedMs,
    queueId: props.queue?.id ?? null,
    queuePosition: item.position ?? null,
    strategy: strategy.value,
  })
}

/** Put this judgement at the head of the history sidebar without refetching it. */
function noteInHistory(item: BufferItem, winner: PairwiseWinner, ids: number[]) {
  if (ids[0] != null) {
    prependEntry(queryClient, { kind: 'pairwise', id: ids[0], post: item.postA, postB: item.postB, dimension: dimension.value, winner })
  }
}

function advancePast(winner: PairwiseWinner) {
  if (winner !== 'skip' && cumulativeCount.value != null) {
    cumulativeCount.value += 1 // 乐观递增，与后端 total（decisive+tie）口径一致
  }
  stream.advance()
}

/** The single entry point for a verdict: it lands on the record under review, or on
 *  the next pair in the queue. Every key and click goes through here. */
function decide(winner: PairwiseWinner) {
  return review.value ? amend(winner) : judge(winner)
}

function judge(winner: PairwiseWinner) {
  return stream.submitCurrent(async (item) => {
    const elapsedMs = stream.elapsedMs()
    const ids = await postJudgement(item, winner, elapsedMs)
    advancePast(winner)
    noteInHistory(item, winner, ids)
    // Ctrl+Z 收回手滑的那几下。会话切到别的维度后，把旧维度的一对塞回新 buffer
    // 会让它被按错维度重判 —— 那种情况下只删事件，不动界面。
    const judgedIn = dimension.value
    stream.pushUndoable({
      item,
      ids,
      label: t(winner === 'skip' ? 'history.skipPair' : 'history.judgePair'),
      redo: async () => {
        const again = await postJudgement(item, winner, elapsedMs)
        advancePast(winner)
        noteInHistory(item, winner, again)
        return again
      },
      stillHere: () => dimension.value === judgedIn,
      onRevert: () => {
        if (winner !== 'skip' && cumulativeCount.value != null) {
          cumulativeCount.value -= 1
        }
      },
    })
  }, error => handleAPIError(error, t('annotate.error.submit')))
}

// ── Keyboard ────────────────────────────────────────────────────────────────
// useHotkey: exact modifiers, nothing while typing or while a layer is open. The
// arrows also fire from a plain button (a clicked history row, the refresh button)
// because none of those use arrows — but not from someone else's composite widget.
const root = useTemplateRef<HTMLElement>('root')
// Esc backs out one level at a time: out of the review first, out of the session
// only when there is no review to leave. Layers swallow Escape before it gets here.
const { notForeign } = useAnnotationSessionFrame({
  root,
  onEscape: () => (review.value ? endReview() : emit('exit')),
  finished: () => exhausted.value && !current.value,
})
const canDecide = () => noLayerOpen() && !!shown.value

useHotkey(['ArrowLeft', 'ArrowRight', 'ArrowDown'], (e) => {
  decide(e.key === 'ArrowLeft' ? 'a' : e.key === 'ArrowRight' ? 'b' : 'tie')
}, { when: canDecide, allowInWidgets: true, ignore: notForeign, repeat: false })
// Space yields to a focused button (it activates it). The picture buttons never keep
// focus from a mouse click, so click-then-Space still skips.
useHotkey('Space', () => decide('skip'), { when: canDecide, ignore: notForeign, repeat: false })

watch(() => [props.queue?.id, props.dimension] as const, () => {
  endReview() // the record belongs to the dimension it was judged in
  stream.reset()
  refreshCumulative()
}, { immediate: true })

const title = computed(() => props.queue?.name ?? t('annotate.pairwise.streamTitle'))

const reviewVerdict = computed(() => winnerLabel(review.value?.winner))

const question = computed(() => {
  const meta = dimensionMeta(dimension.value)
  return meta ? t(meta.questionKey) : t('annotate.dimension.questionFallback', { dimension: dimension.value })
})

const hints = computed(() => [
  { keys: ['←'], label: t('annotate.keys.pickLeft') },
  { keys: ['→'], label: t('annotate.keys.pickRight') },
  { keys: ['↓'], label: t('annotate.keys.tie') },
  { keys: ['Space'], label: t('annotate.keys.skip') },
  { keys: shortcutKeys('Mod+Z'), label: t('annotate.keys.undo') },
  { keys: ['Esc'], label: t('annotate.keys.exit') },
])
</script>

<template>
  <div ref="root" class="pairwise-session flex flex-col h-full" tabindex="-1" role="region" :aria-label="title">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button
          type="button"
          class="pairwise-exit"
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
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <AnnotationKeyHints :hints="hints" />
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <!-- 维度问题横幅；复判时换成"在改哪一条" -->
      <AnnotationReviewBanner v-if="review" :verdict="reviewVerdict" @exit="endReview()" />
      <div v-else :id="`${sessionId}-q`" class="text-sm text-fg font-medium px-4 py-2 text-center p-divider shrink-0">
        {{ question }}
      </div>
      <!-- @mousedown.prevent: a click judges and moves on; it must not leave focus on
           the button, where the next Space would activate it instead of skipping. -->
      <div v-if="shown" class="flex flex-1 gap-1 min-h-0" role="group" :aria-labelledby="review ? undefined : `${sessionId}-q`">
        <button
          type="button"
          class="pairwise-side group"
          :class="{ 'pairwise-side--was': review?.winner === 'a' }"
          :aria-label="$t('annotate.pairwise.pickLeft')"
          :title="`${$t('annotate.pairwise.pickLeft')} (←)`"
          aria-keyshortcuts="ArrowLeft"
          @mousedown.prevent
          @click="decide('a')"
        >
          <img :key="shown.postA.id" :src="imgURL(shown.postA)" :alt="shown.postA.fileName" class="max-h-full max-w-full object-contain" decoding="async">
          <span class="pairwise-side__pick" aria-hidden="true"><kbd>←</kbd> {{ $t('annotate.pairwise.pickThis') }}</span>
        </button>
        <button
          type="button"
          class="pairwise-side group"
          :class="{ 'pairwise-side--was': review?.winner === 'b' }"
          :aria-label="$t('annotate.pairwise.pickRight')"
          :title="`${$t('annotate.pairwise.pickRight')} (→)`"
          aria-keyshortcuts="ArrowRight"
          @mousedown.prevent
          @click="decide('b')"
        >
          <img :key="shown.postB.id" :src="imgURL(shown.postB)" :alt="shown.postB.fileName" class="max-h-full max-w-full object-contain" decoding="async">
          <span class="pairwise-side__pick" aria-hidden="true"><kbd>→</kbd> {{ $t('annotate.pairwise.pickThis') }}</span>
        </button>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3" aria-hidden="true">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            {{ $t('annotate.pairwise.exhausted') }}
          </div>
          <div class="text-xs text-fg-muted mt-1">
            {{ $t('annotate.pairwise.exhaustedDetail', { n: formatNumber(doneCount) }) }}
          </div>
        </div>
        <AnnotationLoadError v-else-if="loadState === 'error'" @retry="stream.refill()" />
        <div v-else role="status" class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="pairwise-spinner" aria-hidden="true" />{{ $t('common.loading') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pairwise-exit {
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
.pairwise-exit:hover {
  background: rgb(var(--p-primary-rgb) / 0.12);
  color: var(--p-fg);
}

.pairwise-session:focus {
  outline: none;
}

.pairwise-side__pick kbd {
  display: inline-block;
  padding: 1px 5px;
  margin: 0 1px;
  font-family: var(--p-font-mono);
  font-size: 10px;
  border: 1px solid var(--p-border);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: inherit;
}

.pairwise-side {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: var(--p-bg);
  cursor: pointer;
}
.pairwise-side::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border: 2px solid transparent;
  transition: border-color var(--p-transition-fast);
}
.pairwise-side:hover::after {
  border-color: rgb(var(--p-primary-rgb) / 0.6);
}
/* The side this record currently says won, so a re-judge starts from what it was
   rather than from a blank slate. Hover still wins, being the stronger signal. */
.pairwise-side--was::after {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
}

.pairwise-side__pick {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  font-size: var(--p-text-xs);
  border-radius: var(--p-radius-full);
  background: rgb(var(--p-scrim-rgb) / 0.55);
  color: white;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--p-transition-fast);
  white-space: nowrap;
}
.pairwise-side:hover .pairwise-side__pick {
  opacity: 1;
}

.pairwise-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--p-border);
  border-top-color: var(--p-primary);
  border-radius: 50%;
  animation: pairwise-spin 0.7s linear infinite;
}
@keyframes pairwise-spin {
  to { transform: rotate(360deg); }
}
</style>
