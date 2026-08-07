<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2NextAbsolute, v2SampleAbsolute, v2SubmitAbsolute, v2SubmitContentFlag, v2UndoAnnotations } from '@/api'
import { activeKeys, KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'
import { useAnnotationReview } from '@/composables/useAnnotationReview'
import { useAPIError } from '@/composables/useAPIError'
import { endReview, prependEntry, pushCommand, removeEntries } from '@/shared'
import { getPostImageURL } from '@/utils'

export interface StreamConfig {
  dimensions: string[]
  scale: number
  strategy: 'random' | 'stratified'
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

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
const totalLabel = computed(() => (props.queue ? `${doneCount.value} / ${props.queue.total}` : `本次已标 ${doneCount.value}`))
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)
const { review, amend } = useAnnotationReview({ kind: 'absolute', field: 'value', labelKey: 'history.annotatePost', submitting })
// The picture on screen, and the dimensions to ask about. A record is ONE
// (post, dimension) event, so reviewing narrows the panel to that one row rather
// than re-asking every dimension the session was configured with.
const shownPost = computed(() => review.value?.post ?? current.value?.post)
const shownDimensions = computed(() => (review.value?.dimension ? [review.value.dimension] : dimensions.value))
const shownScale = computed(() => review.value?.scale ?? scale.value)
// stream 模式：本会话内跳过/已出过的图不再入 buffer
const seenIds = new Set<number>()

const choices = ref<Record<string, number>>({})
const flagState = ref<'none' | 'love' | 'hate'>('none')
let shownAt = performance.now()
const elapsed = ref<Record<string, number>>({})

// 预热 buffer 中接下来几张的原图：标注当前图的几秒钟里，下一张已进
// 浏览器缓存，切图即显示（同 useAdjacentImagePreload 的思路）。
const PRELOAD_AHEAD = 3
const preloaded = new Set<string>()
function preloadAhead() {
  for (const item of buffer.value.slice(1, 1 + PRELOAD_AHEAD)) {
    const url = postURL(item.post)
    if (!preloaded.has(url)) {
      preloaded.add(url)
      const img = new Image()
      img.src = url
    }
  }
}

function postURL(p: QueueItemPostPublic) {
  return getPostImageURL({ filePath: p.filePath, fileName: p.fileName, extension: p.extension, sha256: p.sha256 })
}

// 见 PairwiseAnnotationSession：低于 LOW_WATER 就后台补货，refilling 是并发闸
// （refill 不再被 await，两个并发请求会各自去重后返回空，误判 exhausted）。
// 单图采样比对比采样便宜（~200ms，不走 KNN），但同样不该卡在按键路径上。
const LOW_WATER = 10
let refilling = false

async function refill() {
  if (exhausted.value || refilling || buffer.value.length >= LOW_WATER) {
    return
  }
  refilling = true
  try {
    let fresh: BufferItem[]
    if (props.queue) {
      const resp = await v2NextAbsolute({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
      const known = new Set(buffer.value.map(i => i.position))
      fresh = (resp.data ?? []).filter(i => !known.has(i.position)).map(i => ({ post: i.post, position: i.position }))
    }
    else {
      const resp = await v2SampleAbsolute({
        query: { dimensions: dimensions.value, strategy: props.config?.strategy ?? 'random', limit: 20 },
      })
      fresh = (resp.data ?? []).filter(p => !seenIds.has(p.id)).map(p => ({ post: p }))
      for (const i of fresh) {
        seenIds.add(i.post.id)
      }
    }
    buffer.value.push(...fresh)
    if (fresh.length === 0) {
      exhausted.value = true
    }
    preloadAhead()
  }
  catch (error) {
    handleAPIError(error, '加载图片失败')
  }
  finally {
    refilling = false
  }
}

function resetForNext() {
  choices.value = {}
  elapsed.value = {}
  flagState.value = 'none'
  shownAt = performance.now()
}

function advance() {
  buffer.value.shift()
  doneCount.value += 1
  resetForNext()
  preloadAhead()
  void refill() // 后台补货，别让采样延迟卡住翻页
}

/**
 * 把这一张压进全局撤销栈，Ctrl+Z 收回手滑的那几下。
 *
 * 走 pushCommand 而不是 record()：record() 每张都弹 snackbar，会一直盖着图。
 * revert 真删事件行（后端 /annotations/undo），不是只退界面——误标会直接进
 * export_annotations 的训练集，而队列项也得重新打开才能再标一次。
 *
 * ids 为空是合法的：跳过一张只标 done、不写事件，撤销就只是把 done 撤掉。
 * 题材 flag 不进撤销栈：'none' 本来就是它自己的撤回，且它是另一条事件流。
 */
function recordItem(item: BufferItem, ids: number[], label: string, redo: () => Promise<number[]>) {
  const restore = { choices: choices.value, elapsed: elapsed.value, flag: flagState.value }
  // redo 必须交回新写入的 row id：重做是一次新的 INSERT，沿用旧 id 会让下一次
  // 撤销删到一个已经不存在的行，把刚重做的那条留在库里。
  let eventIds = ids
  pushCommand({
    label,
    postIds: [], // 不改画廊选中：这张图自己会回到屏幕上
    apply: async () => {
      eventIds = await redo()
    },
    revert: async () => {
      await v2UndoAnnotations({
        body: {
          kind: 'absolute',
          ids: eventIds,
          session_id: sessionId,
          queue_id: props.queue?.id ?? null,
          queue_position: item.position ?? null,
        },
      })
      removeEntries(queryClient, 'absolute', eventIds) // 事件已删，历史列表也不该再有它
      buffer.value.unshift(item)
      exhausted.value = false
      doneCount.value = Math.max(0, doneCount.value - 1)
      // 把上一张的档位选择也还原，撤销后能看到当时按了什么、只改错的那一档。
      choices.value = restore.choices
      elapsed.value = restore.elapsed
      flagState.value = restore.flag
      shownAt = performance.now()
    },
  })
}

async function postAnnotation(item: BufferItem): Promise<number[]> {
  const dims = dimensions.value
  const resp = await v2SubmitAbsolute({
    body: {
      events: dims.map(d => ({
        post_id: item.post.id,
        dimension: d,
        scale: scale.value,
        value: choices.value[d],
        rubric_version: rubricVersions.value[d],
        session_id: sessionId,
        elapsed_ms: elapsed.value[d] ?? null,
      })),
      queue_id: props.queue?.id ?? null,
      queue_position: item.position ?? null,
    },
  })
  const ids = resp.data?.ids ?? []
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

async function submitAndAdvance() {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  submitting.value = true
  try {
    const ids = await postAnnotation(item)
    recordItem(item, ids, t('history.annotatePost'), async () => {
      const again = await postAnnotation(item)
      advance()
      return again
    })
    advance()
  }
  catch (error) {
    handleAPIError(error, '提交失败')
  }
  finally {
    submitting.value = false
  }
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
  elapsed.value = { ...elapsed.value, [dimension]: Math.round(performance.now() - shownAt) }
  if (dimensions.value.every(d => choices.value[d] != null)) {
    submitAndAdvance()
  }
}

// 维度×档位按键：行 = 维度，列 = 档位
onKeyStroke(activeKeys(dimensions.value, scale.value), (e) => {
  e.preventDefault()
  const choice = keyToChoice(e.key, dimensions.value, scale.value)
  if (choice) {
    selectChoice(choice.dimension, choice.value)
  }
})

// 0 = 题材 flag 循环（事件流：每次按键都记录，'none' 即撤销）
onKeyStroke('0', async (e) => {
  if (!current.value) {
    return
  }
  e.preventDefault()
  const next = flagState.value === 'none' ? 'love' : flagState.value === 'love' ? 'hate' : 'none'
  const post = current.value.post
  flagState.value = next
  try {
    const resp = await v2SubmitContentFlag({ body: { post_id: post.id, flag: next, session_id: sessionId } })
    // Flags are the third stream in the history list and were the one that never
    // reached its head — they only appeared, mid-list, after a manual refresh.
    const id = resp.data?.ids?.[0]
    if (id != null) {
      prependEntry(queryClient, { kind: 'flag', id, post, flag: next })
    }
  }
  catch (error) {
    handleAPIError(error, 'flag 失败')
  }
})

// Space = 跳过整张图（queue：标 done 不发事件；stream：本会话内不再出现）
onKeyStroke(' ', async (e) => {
  if (!current.value || submitting.value) {
    return
  }
  e.preventDefault()
  const item = current.value
  if (props.queue) {
    submitting.value = true
    try {
      const skipItem = async (): Promise<number[]> => {
        await v2SubmitAbsolute({ body: { events: [], queue_id: props.queue!.id, queue_position: item.position ?? null } })
        advance()
        return [] // 跳过不写事件，只翻 done 标记
      }
      await skipItem()
      // 队列跳过没有事件行可删，撤销就是把队列项重新打开（ids 为空）。
      recordItem(item, [], t('history.skipPost'), skipItem)
    }
    catch (error) {
      handleAPIError(error, '跳过失败')
    }
    finally {
      submitting.value = false
    }
  }
  else {
    // 流式跳过完全不落库，撤销纯粹是本地的：把图放回去、别再被去重挡住。
    buffer.value.shift()
    resetForNext()
    preloadAhead()
    void refill()
    pushCommand({
      label: t('history.skipPost'),
      postIds: [],
      apply: async () => {
        buffer.value.shift()
        seenIds.add(item.post.id)
        resetForNext()
      },
      revert: async () => {
        seenIds.delete(item.post.id)
        buffer.value.unshift(item)
        exhausted.value = false
        resetForNext()
      },
    })
  }
})

onKeyStroke('Escape', (e) => {
  e.preventDefault()
  // Esc leaves the review first, the session only when there is no review to leave.
  if (review.value) {
    endReview()
    return
  }
  emit('exit')
})

watch(() => [props.queue?.id, props.config] as const, () => {
  endReview()
  buffer.value = []
  seenIds.clear()
  exhausted.value = false
  doneCount.value = props.queue?.done ?? 0
  resetForNext()
  refill()
}, { immediate: true })

const SCALE_LABELS: Record<number, string[]> = {
  2: ['不好', '好'],
  3: ['差', '中', '好'],
  5: ['1', '2', '3', '4', '5'],
}
const labels = computed(() => SCALE_LABELS[shownScale.value] ?? SCALE_LABELS[2])
const title = computed(() => props.queue?.name ?? `流式标注 · ${dimensions.value.join(' / ')}`)

// 维度显示成引导问题而非冷标签，把注意力锚到该维度的特征上（抗 halo）。
const DIMENSION_META: Record<string, { label: string, prompt: string, icon: string }> = {
  color: { label: '颜色', prompt: '配色运用得好吗？不是丰富度，忽略题材。', icon: 'i-tabler-palette' },
  finish: { label: '完成度', prompt: '精修、装饰精致吗？草稿感还是想放大看？', icon: 'i-tabler-brush' },
  composition: { label: '构图', prompt: '演出有想法吗？姿势动态、角度、布景。', icon: 'i-tabler-layout-collage' },
  overall: { label: '总分', prompt: '总体喜欢吗？', icon: 'i-tabler-star' },
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button class="annotate-exit" title="退出（Esc）" @click="emit('exit')">
          <i class="i-tabler-arrow-left" />
        </button>
        <span class="text-fg font-medium truncate">{{ title }}</span>
        <span v-if="flagState !== 'none'" class="text-xs shrink-0">
          {{ flagState === 'love' ? '❤️ 喜欢的题材' : '💢 讨厌的题材' }}
        </span>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <span class="annotate-hotkeys"><kbd>Space</kbd> 跳过 <kbd>0</kbd> 题材 <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 <kbd>Esc</kbd> 退出</span>
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
              <i :class="DIMENSION_META[dim]?.icon" class="annotate-judge-card__icon" />
              <span class="text-sm text-fg font-medium">{{ DIMENSION_META[dim]?.label ?? dim }}</span>
            </div>
            <p class="text-xs text-fg-muted leading-relaxed mt-1">
              {{ DIMENSION_META[dim]?.prompt }}
            </p>
            <div class="mt-3 flex gap-1.5">
              <button
                v-for="(label, i) in labels"
                :key="i"
                class="annotate-choice"
                :class="{ 'annotate-choice--active': review ? review.value === i + 1 : choices[dim] === i + 1 }"
                @click="selectChoice(dim, i + 1)"
              >
                <kbd>{{ KEY_ROWS[row][i] }}</kbd>
                <span>{{ label }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            没有更多待标图片了
          </div>
          <div class="text-xs text-fg-muted mt-1">
            本次共标注 {{ doneCount }} 张 · 按 <kbd class="annotate-kbd-inline">Esc</kbd> 返回
          </div>
        </div>
        <div v-else class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="annotate-spinner" />加载中…
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

.annotate-hotkeys kbd,
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

/* 档位按钮 */
.annotate-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  font-size: var(--p-text-sm);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast),
    color var(--p-transition-fast),
    transform var(--p-transition-fast);
}
.annotate-choice:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.55);
  color: var(--p-fg);
}
.annotate-choice:active {
  transform: scale(0.96);
}
.annotate-choice--active {
  background: var(--p-primary);
  border-color: var(--p-primary);
  color: white;
}
.annotate-choice kbd {
  font-family: var(--p-font-mono);
  font-size: 10px;
  opacity: 0.65;
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
