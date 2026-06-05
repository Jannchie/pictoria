<script setup lang="ts">
import type { AbsoluteQueueItemPublic, QueueSummaryPublic } from '@/api'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextAbsolute, v2SubmitAbsolute, v2SubmitContentFlag } from '@/api'
import { activeKeys, KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

const props = defineProps<{ queue: QueueSummaryPublic }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const scale = computed(() => props.queue.scale ?? 2)
const rubricVersions = computed(() => Object.fromEntries(props.queue.dimensions.map(d => [d, `${d}-v1`])))

const buffer = ref<AbsoluteQueueItemPublic[]>([])
const doneCount = ref(props.queue.done)
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)

const choices = ref<Record<string, number>>({})
const flagState = ref<'none' | 'love' | 'hate'>('none')
let shownAt = performance.now()
const elapsed = ref<Record<string, number>>({})

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) {
    return
  }
  try {
    const resp = await v2NextAbsolute({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
    const items = resp.data ?? []
    const known = new Set(buffer.value.map(i => i.position))
    buffer.value.push(...items.filter(i => !known.has(i.position)))
    if (items.length === 0) {
      exhausted.value = true
    }
  }
  catch (error) {
    handleAPIError(error, '加载队列失败')
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
        events: props.queue.dimensions.map(d => ({
          post_id: item.post.id,
          dimension: d,
          scale: scale.value,
          value: choices.value[d],
          rubric_version: rubricVersions.value[d],
          session_id: sessionId,
          elapsed_ms: elapsed.value[d] ?? null,
        })),
        queue_id: props.queue.id,
        queue_position: item.position,
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
onKeyStroke(activeKeys(props.queue.dimensions, scale.value), (e) => {
  if (!current.value || submitting.value) {
    return
  }
  e.preventDefault()
  const choice = keyToChoice(e.key, props.queue.dimensions, scale.value)
  if (!choice) {
    return
  }
  choices.value = { ...choices.value, [choice.dimension]: choice.value }
  elapsed.value = { ...elapsed.value, [choice.dimension]: Math.round(performance.now() - shownAt) }
  if (props.queue.dimensions.every(d => choices.value[d] != null)) {
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

// Space = 跳过整张图（仅标 done，不发事件）
onKeyStroke(' ', async (e) => {
  if (!current.value || submitting.value) {
    return
  }
  e.preventDefault()
  submitting.value = true
  try {
    await v2SubmitAbsolute({ body: { events: [], queue_id: props.queue.id, queue_position: current.value.position } })
    await advance()
  }
  catch (error) {
    handleAPIError(error, '跳过失败')
  }
  finally {
    submitting.value = false
  }
})

onKeyStroke('Escape', (e) => {
  e.preventDefault()
  emit('exit')
})

watch(() => props.queue.id, () => {
  buffer.value = []
  exhausted.value = false
  doneCount.value = props.queue.done
  resetForNext()
  refill()
}, { immediate: true })

const SCALE_LABELS: Record<number, string[]> = {
  2: ['不好', '好'],
  3: ['差', '中', '好'],
  5: ['1', '2', '3', '4', '5'],
}
const labels = computed(() => SCALE_LABELS[scale.value] ?? SCALE_LABELS[2])
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="text-sm px-3 py-2 p-divider flex items-center justify-between">
      <span>{{ queue.name }}</span>
      <span class="text-fg-muted">
        {{ doneCount }} / {{ queue.total }} · Esc 退出 · Space 跳过 · 0 题材flag<template v-if="flagState !== 'none'">（{{ flagState }}）</template>
      </span>
    </div>

    <div v-if="current" class="flex flex-1 min-h-0">
      <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
        <img
          :key="current.post.id"
          :src="getPostImageURL({ filePath: current.post.filePath, fileName: current.post.fileName, extension: current.post.extension, sha256: current.post.sha256 })"
          :alt="current.post.fileName"
          class="max-h-full max-w-full object-contain"
          decoding="async"
        >
      </div>
      <div class="p-3 border-l border-border-default flex shrink-0 flex-col gap-3 w-56">
        <div v-for="(dim, row) in queue.dimensions" :key="dim">
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
      {{ exhausted ? '队列已全部完成 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
