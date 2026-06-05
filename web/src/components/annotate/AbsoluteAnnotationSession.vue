<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextAbsolute, v2SampleAbsolute, v2SubmitAbsolute, v2SubmitContentFlag } from '@/api'
import { activeKeys, KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'
import { useAPIError } from '@/composables/useAPIError'
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

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) {
    return
  }
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
}

function resetForNext() {
  choices.value = {}
  elapsed.value = {}
  flagState.value = 'none'
  shownAt = performance.now()
}

async function advance() {
  buffer.value.shift()
  doneCount.value += 1
  resetForNext()
  preloadAhead()
  await refill()
}

async function submitAndAdvance() {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  submitting.value = true
  try {
    await v2SubmitAbsolute({
      body: {
        events: dimensions.value.map(d => ({
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
    await advance()
  }
  catch (error) {
    handleAPIError(error, '提交失败')
  }
  finally {
    submitting.value = false
  }
}

// 选择一个档位（键盘与鼠标共用）：记录耗时，选满全部维度即提交翻页
function selectChoice(dimension: string, value: number) {
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
  flagState.value = next
  try {
    await v2SubmitContentFlag({ body: { post_id: current.value.post.id, flag: next, session_id: sessionId } })
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
  if (props.queue) {
    submitting.value = true
    try {
      await v2SubmitAbsolute({ body: { events: [], queue_id: props.queue.id, queue_position: current.value.position ?? null } })
      await advance()
    }
    catch (error) {
      handleAPIError(error, '跳过失败')
    }
    finally {
      submitting.value = false
    }
  }
  else {
    buffer.value.shift()
    resetForNext()
    preloadAhead()
    await refill()
  }
})

onKeyStroke('Escape', (e) => {
  e.preventDefault()
  emit('exit')
})

watch(() => [props.queue?.id, props.config] as const, () => {
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
const labels = computed(() => SCALE_LABELS[scale.value] ?? SCALE_LABELS[2])
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
        <span class="annotate-hotkeys"><kbd>Space</kbd> 跳过 <kbd>0</kbd> 题材 <kbd>Esc</kbd> 退出</span>
      </div>
    </div>

    <div v-if="current" class="flex flex-1 min-h-0">
      <!-- 图片区 -->
      <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
        <img
          :key="current.post.id"
          :src="postURL(current.post)"
          :alt="current.post.fileName"
          class="max-h-full max-w-full object-contain"
          decoding="async"
        >
      </div>

      <!-- 判断面板 -->
      <div class="px-4 py-5 border-l border-border-subtle flex shrink-0 flex-col gap-4 w-72 overflow-y-auto">
        <div
          v-for="(dim, row) in dimensions"
          :key="dim"
          class="annotate-judge-card"
          :class="{ 'annotate-judge-card--done': choices[dim] != null }"
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
              :class="{ 'annotate-choice--active': choices[dim] === i + 1 }"
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
  transition: background-color var(--p-duration-fast) var(--p-ease), color var(--p-duration-fast) var(--p-ease);
}
.annotate-exit:hover {
  background: rgb(var(--p-brand-500-rgb) / 0.12);
  color: var(--p-fg);
}

.annotate-hotkeys kbd,
.annotate-kbd-inline {
  display: inline-block;
  padding: 1px 5px;
  margin: 0 1px;
  font-family: var(--p-font-mono);
  font-size: 10px;
  border: 1px solid var(--p-border-default);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: var(--p-fg-muted);
}

/* 判断卡片 */
.annotate-judge-card {
  padding: 13px 14px;
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-lg);
  transition: border-color var(--p-duration-fast) var(--p-ease), opacity var(--p-duration-fast) var(--p-ease);
}
.annotate-judge-card--done {
  opacity: 0.62;
}
.annotate-judge-card:not(.annotate-judge-card--done) {
  border-color: rgb(var(--p-brand-500-rgb) / 0.45);
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
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-md);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition:
    border-color var(--p-duration-fast) var(--p-ease),
    background-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease),
    transform var(--p-duration-fast) var(--p-ease);
}
.annotate-choice:hover {
  border-color: rgb(var(--p-brand-500-rgb) / 0.55);
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
  border: 2px solid var(--p-border-default);
  border-top-color: var(--p-primary);
  border-radius: 50%;
  animation: annotate-spin 0.7s linear infinite;
}
@keyframes annotate-spin {
  to { transform: rotate(360deg); }
}
</style>
