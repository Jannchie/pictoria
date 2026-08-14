<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2CountPairwise, v2NextPairwise, v2SamplePairwise, v2SubmitPairwise, v2UndoAnnotations } from '@/api'
import { useAnnotationReview } from '@/composables/useAnnotationReview'
import { useAPIError } from '@/composables/useAPIError'
import { endReview, prependEntry, pushCommand, removeEntries, winnerLabel } from '@/shared'
import { getPostImageURL } from '@/utils'

interface BufferItem {
  postA: QueueItemPostPublic
  postB: QueueItemPostPublic
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则按 dimension 流式采样。
// strategy 仅流式有效：close = 视觉相近且模型分不开的边界对，并自动接上已标过的比较图（默认）；
// similar = 内容相似 + 旧分相近（不参考模型，留作评估）；random = 全库随机。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: string, strategy?: 'random' | 'similar' | 'close' }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()
const { t } = useI18n()
const queryClient = useQueryClient()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'overall')

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
// 该维度数据库累计已判（decisive + tie，skip 不计）；流式模式下顶栏展示进度感。
const cumulativeCount = ref<number | null>(null)
const totalLabel = computed(() => {
  if (props.queue) {
    return `${doneCount.value} / ${props.queue.total}`
  }
  const cum = cumulativeCount.value == null ? '' : ` · 累计 ${cumulativeCount.value}`
  return `本次 ${doneCount.value}${cum}`
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
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)
const { review, amend } = useAnnotationReview({ kind: 'pairwise', field: 'winner', labelKey: 'history.judgePair', submitting })

// What the two panes show. Reviewing borrows the whole judging surface rather than
// opening a second one — the decision is identical, so the keys, the click targets
// and the picture size should be too. Only where the verdict LANDS changes.
const shown = computed(() => {
  const r = review.value
  return r?.postB ? { postA: r.post, postB: r.postB } : current.value
})
const seenKeys = new Set<string>()
let emptyStreak = 0
let shownAt = performance.now()

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL({ filePath: p.filePath, fileName: p.fileName, extension: p.extension, sha256: p.sha256 })
}

// 预热接下来几对的原图：判断当前对的几秒钟里，下一对已进浏览器缓存。
const PRELOAD_AHEAD = 2
const preloaded = new Set<string>()
function preloadAhead() {
  for (const item of buffer.value.slice(1, 1 + PRELOAD_AHEAD)) {
    for (const url of [imgURL(item.postA), imgURL(item.postB)]) {
      if (!preloaded.has(url)) {
        preloaded.add(url)
        const img = new Image()
        img.src = url
      }
    }
  }
}

// 补货水位与并发闸。
// LOW_WATER 是「低于这么多就去补」，不是「补到这么多」——后端一次给 20 条。
// 取 10 而非 5，是因为流式采样要跑 vec0 KNN（214k 图暴力扫，一次邻域 ~0.9s；
// 实测一批 20 对 close ≈ 1.2s、similar ≈ 3.5s）。水位越低，越可能在 buffer
// 见底、用户已经无图可判时才补上。
const LOW_WATER = 10
// refill 不再被 await，所以同一时刻可能被触发两次：没有这道闸，两个请求会
// 各自去重后都返回空，把 exhausted 误判成「判完了」。
let refilling = false

async function refill() {
  if (exhausted.value || refilling || buffer.value.length >= LOW_WATER) {
    return
  }
  refilling = true
  try {
    await refillOnce()
  }
  finally {
    refilling = false
  }
}

// 闸在 refill() 上，不在这里：空响应时的重试是同一次补货的第二轮，
// 走 refill() 会被自己的闸挡回去，静默变成不重试。
async function refillOnce(): Promise<void> {
  try {
    let fresh: BufferItem[]
    if (props.queue) {
      const resp = await v2NextPairwise({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
      const known = new Set(buffer.value.map(i => i.position))
      fresh = (resp.data ?? []).filter(i => !known.has(i.position)).map(i => ({ postA: i.postA, postB: i.postB, position: i.position }))
    }
    else {
      const resp = await v2SamplePairwise({ query: { limit: 20, strategy: props.strategy ?? 'close' } })
      fresh = (resp.data ?? [])
        .map(p => ({ postA: p.postA, postB: p.postB }))
        .filter((p) => {
          const key = `${p.postA.id}-${p.postB.id}`
          if (seenKeys.has(key)) {
            return false
          }
          seenKeys.add(key)
          return true
        })
    }
    buffer.value.push(...fresh)
    // 一次空响应不等于标完了：close 每次只抽几个种子，可能刚好都已经比够或没有模型分。
    // 连续两次空才收摊，否则会在还剩十万张图的时候弹「没有更多了」。
    emptyStreak = fresh.length === 0 ? emptyStreak + 1 : 0
    if (emptyStreak >= 2) {
      exhausted.value = true
    }
    else if (fresh.length === 0) {
      await refillOnce()
    }
    preloadAhead()
  }
  catch (error) {
    handleAPIError(error, '加载图片失败')
  }
}

type Winner = 'a' | 'b' | 'tie' | 'skip'

async function postJudgement(item: BufferItem, winner: Winner, elapsedMs: number): Promise<number[]> {
  const resp = await v2SubmitPairwise({
    body: {
      post_a: item.postA.id,
      post_b: item.postB.id,
      dimension: dimension.value,
      winner,
      rubric_version: `${dimension.value}-v1`,
      session_id: sessionId,
      elapsed_ms: elapsedMs,
      queue_id: props.queue?.id ?? null,
      queue_position: item.position ?? null,
    },
  })
  return resp.data?.ids ?? []
}

/** Put this judgement at the head of the history sidebar without refetching it. */
function noteInHistory(item: BufferItem, winner: Winner, ids: number[]) {
  if (ids[0] != null) {
    prependEntry(queryClient, { kind: 'pairwise', id: ids[0], post: item.postA, postB: item.postB, dimension: dimension.value, winner })
  }
}

function advancePast(winner: Winner) {
  buffer.value.shift()
  doneCount.value += 1
  if (winner !== 'skip' && cumulativeCount.value != null) {
    cumulativeCount.value += 1 // 乐观递增，与后端 total（decisive+tie）口径一致
  }
  shownAt = performance.now()
  preloadAhead()
  // 不 await：采样要跑 KNN，await 会把那 1~3.5 秒直接压进按键响应里——
  // 判到第 16 对时按下方向键，画面会停在已经判完的那一对上等采样返回。
  // buffer 还有 LOW_WATER 条垫着，补货在后台跑完即可。
  void refill()
}

/**
 * 把这一判压进全局撤销栈，让 Ctrl+Z 能收回手滑的那几下。
 *
 * 走 pushCommand 而不是 mutations.ts 的 record()：record() 每次都会弹 snackbar，
 * 而这里一秒一判，弹窗会一直盖在图上。压栈不弹，撤销时 performUndo 自己会弹。
 *
 * 撤销必须真删事件行（后端 /annotations/undo），不能只退界面：误判会直接进
 * export_annotations 的训练集，而采样器的 _judged_graph 会永久认为这对问过了。
 */
function recordJudgement(item: BufferItem, winner: Winner, elapsedMs: number, ids: number[]) {
  // 会话切到别的维度后，把旧维度的一对塞回新 buffer 会让它被按错维度重判。
  // 那种情况下只删事件，不动界面。
  const judgedIn = dimension.value
  let eventIds = ids
  pushCommand({
    label: t(winner === 'skip' ? 'history.skipPair' : 'history.judgePair'),
    // 空数组 = 不改画廊选中。这里的"定位"是那对图自己回到屏幕上，
    // 而在全屏会话背后改画廊选中是个看不见的副作用。
    postIds: [],
    apply: async () => {
      eventIds = await postJudgement(item, winner, elapsedMs)
      advancePast(winner)
      noteInHistory(item, winner, eventIds)
    },
    revert: async () => {
      await v2UndoAnnotations({
        body: {
          kind: 'pairwise',
          ids: eventIds,
          session_id: sessionId,
          queue_id: props.queue?.id ?? null,
          queue_position: item.position ?? null,
        },
      })
      removeEntries(queryClient, 'pairwise', eventIds) // 事件已删，历史列表也不该再有它
      if (dimension.value !== judgedIn) {
        return
      }
      buffer.value.unshift(item)
      exhausted.value = false // 判完最后一对时是 true，撤销后又有的判了
      doneCount.value -= 1
      if (winner !== 'skip' && cumulativeCount.value != null) {
        cumulativeCount.value -= 1
      }
      shownAt = performance.now()
    },
  })
}

/** The single entry point for a verdict: it lands on the record under review, or on
 *  the next pair in the queue. Every key and click goes through here. */
function decide(winner: Winner) {
  return review.value ? amend(winner) : judge(winner)
}

async function judge(winner: Winner) {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  submitting.value = true
  const elapsedMs = Math.round(performance.now() - shownAt)
  try {
    const ids = await postJudgement(item, winner, elapsedMs)
    advancePast(winner)
    noteInHistory(item, winner, ids)
    recordJudgement(item, winner, elapsedMs, ids)
  }
  catch (error) {
    handleAPIError(error, '提交失败')
  }
  finally {
    submitting.value = false
  }
}

onKeyStroke(['ArrowLeft', 'ArrowRight', 'ArrowDown', ' '], (e) => {
  if (!shown.value) {
    return
  }
  e.preventDefault()
  const winner = e.key === 'ArrowLeft' ? 'a' : e.key === 'ArrowRight' ? 'b' : e.key === 'ArrowDown' ? 'tie' : 'skip'
  decide(winner)
})
onKeyStroke('Escape', (e) => {
  e.preventDefault()
  // Esc backs out one level at a time: out of the review first, out of the session
  // only when there is no review to leave.
  if (review.value) {
    endReview()
    return
  }
  emit('exit')
})

watch(() => [props.queue?.id, props.dimension] as const, () => {
  endReview() // the record belongs to the dimension it was judged in
  buffer.value = []
  seenKeys.clear()
  emptyStreak = 0
  exhausted.value = false
  doneCount.value = props.queue?.done ?? 0
  shownAt = performance.now()
  refill()
  refreshCumulative()
}, { immediate: true })

const title = computed(() => props.queue?.name ?? '流式对比')

const reviewVerdict = computed(() => winnerLabel(review.value?.winner))

const DIMENSION_QUESTIONS: Record<string, string> = {
  color: '哪边的配色运用更好？',
  finish: '哪边的完成度更高？',
  composition: '哪边的构图演出更有想法？',
  overall: '总体更喜欢哪边？',
}
const question = computed(() => DIMENSION_QUESTIONS[dimension.value] ?? `哪边的 ${dimension.value} 更好？`)
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button class="pairwise-exit" title="退出（Esc）" @click="emit('exit')">
          <i class="i-tabler-arrow-left" />
        </button>
        <span class="text-fg font-medium truncate">{{ title }}</span>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <span class="pairwise-hotkeys"><kbd>↓</kbd> 平手 <kbd>Space</kbd> 跳过 <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 <kbd>Esc</kbd> 退出</span>
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <!-- 维度问题横幅；复判时换成"在改哪一条" -->
      <AnnotationReviewBanner v-if="review" :verdict="reviewVerdict" @exit="endReview()" />
      <div v-else class="text-sm text-fg font-medium px-4 py-2 text-center p-divider shrink-0">
        {{ question }}
      </div>
      <div v-if="shown" class="flex flex-1 gap-1 min-h-0">
        <button
          class="pairwise-side group"
          :class="{ 'pairwise-side--was': review?.winner === 'a' }"
          title="选左边（←）"
          @click="decide('a')"
        >
          <img :key="shown.postA.id" :src="imgURL(shown.postA)" :alt="shown.postA.fileName" class="max-h-full max-w-full object-contain" decoding="async">
          <span class="pairwise-side__pick"><kbd>←</kbd> 选这边</span>
        </button>
        <button
          class="pairwise-side group"
          :class="{ 'pairwise-side--was': review?.winner === 'b' }"
          title="选右边（→）"
          @click="decide('b')"
        >
          <img :key="shown.postB.id" :src="imgURL(shown.postB)" :alt="shown.postB.fileName" class="max-h-full max-w-full object-contain" decoding="async">
          <span class="pairwise-side__pick"><kbd>→</kbd> 选这边</span>
        </button>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            没有更多待判图片了
          </div>
          <div class="text-xs text-fg-muted mt-1">
            本次共判断 {{ doneCount }} 对
          </div>
        </div>
        <div v-else class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="pairwise-spinner" />加载中…
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

.pairwise-hotkeys kbd,
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
  background: rgb(0 0 0 / 0.55);
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
