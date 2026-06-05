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

// 维度×档位按键：行 = 维度，列 = 档位
onKeyStroke(activeKeys(dimensions.value, scale.value), (e) => {
  if (!current.value || submitting.value) {
    return
  }
  e.preventDefault()
  const choice = keyToChoice(e.key, dimensions.value, scale.value)
  if (!choice) {
    return
  }
  choices.value = { ...choices.value, [choice.dimension]: choice.value }
  elapsed.value = { ...elapsed.value, [choice.dimension]: Math.round(performance.now() - shownAt) }
  if (dimensions.value.every(d => choices.value[d] != null)) {
    submitAndAdvance()
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
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="text-sm px-3 py-2 p-divider flex items-center justify-between">
      <span>{{ title }}</span>
      <span class="text-fg-muted">
        {{ totalLabel }} · Esc 退出 · Space 跳过 · 0 题材flag<template v-if="flagState !== 'none'">（{{ flagState }}）</template>
      </span>
    </div>

    <div v-if="current" class="flex flex-1 min-h-0">
      <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
        <img
          :key="current.post.id"
          :src="postURL(current.post)"
          :alt="current.post.fileName"
          class="max-h-full max-w-full object-contain"
          decoding="async"
        >
      </div>
      <div class="p-3 border-l border-border-default flex shrink-0 flex-col gap-3 w-56">
        <div v-for="(dim, row) in dimensions" :key="dim">
          <div class="text-xs text-fg-muted mb-1">
            {{ dim }}
          </div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="(label, i) in labels"
              :key="i"
              class="text-xs px-2 py-1 p-border rounded"
              :class="choices[dim] === i + 1 ? 'bg-primary text-white border-primary' : 'text-fg-muted'"
            >
              <kbd class="mr-1 opacity-60">{{ KEY_ROWS[row][i] }}</kbd>{{ label }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="text-sm text-fg-muted flex flex-1 items-center justify-center">
      {{ exhausted ? '没有更多待标图片了 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
