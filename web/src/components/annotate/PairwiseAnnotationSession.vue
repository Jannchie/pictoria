<script setup lang="ts">
import type { PairwiseQueueItemPublic, QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextPairwise, v2SubmitPairwise } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

const props = defineProps<{ queue: QueueSummaryPublic }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue.dimensions[0])

const buffer = ref<PairwiseQueueItemPublic[]>([])
const doneCount = ref(props.queue.done)
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)
let shownAt = performance.now()

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) {
    return
  }
  try {
    const resp = await v2NextPairwise({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
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

async function judge(winner: 'a' | 'b' | 'tie' | 'skip') {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  submitting.value = true
  try {
    await v2SubmitPairwise({
      body: {
        post_a: item.postA.id,
        post_b: item.postB.id,
        dimension: dimension.value,
        winner,
        rubric_version: `${dimension.value}-v1`,
        session_id: sessionId,
        elapsed_ms: Math.round(performance.now() - shownAt),
        queue_id: props.queue.id,
        queue_position: item.position,
      },
    })
    buffer.value.shift()
    doneCount.value += 1
    shownAt = performance.now()
    await refill()
  }
  catch (error) {
    handleAPIError(error, '提交失败')
  }
  finally {
    submitting.value = false
  }
}

onKeyStroke(['ArrowLeft', 'ArrowRight', 'ArrowDown', ' '], (e) => {
  if (!current.value) {
    return
  }
  e.preventDefault()
  const winner = e.key === 'ArrowLeft' ? 'a' : e.key === 'ArrowRight' ? 'b' : e.key === 'ArrowDown' ? 'tie' : 'skip'
  judge(winner)
})
onKeyStroke('Escape', (e) => {
  e.preventDefault()
  emit('exit')
})

watch(() => props.queue.id, () => {
  buffer.value = []
  exhausted.value = false
  doneCount.value = props.queue.done
  shownAt = performance.now()
  refill()
}, { immediate: true })

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL({ filePath: p.filePath, fileName: p.fileName, extension: p.extension, sha256: p.sha256 })
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="text-sm px-3 py-2 p-divider flex items-center justify-between">
      <span>{{ queue.name }} · <b>{{ dimension }}</b> 哪边更好？</span>
      <span class="text-fg-muted">{{ doneCount }} / {{ queue.total }} · ← 左 · → 右 · ↓ 平 · Space 跳过 · Esc 退出</span>
    </div>

    <div v-if="current" class="flex flex-1 gap-1 min-h-0">
      <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
        <img :key="current.postA.id" :src="imgURL(current.postA)" :alt="current.postA.fileName" class="max-h-full max-w-full object-contain" decoding="async">
      </div>
      <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
        <img :key="current.postB.id" :src="imgURL(current.postB)" :alt="current.postB.fileName" class="max-h-full max-w-full object-contain" decoding="async">
      </div>
    </div>

    <div v-else class="text-sm text-fg-muted flex flex-1 items-center justify-center">
      {{ exhausted ? '队列已全部完成 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
