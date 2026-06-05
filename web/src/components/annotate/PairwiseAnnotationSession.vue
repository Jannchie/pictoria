<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextPairwise, v2SamplePairwise, v2SubmitPairwise } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

interface BufferItem {
  postA: QueueItemPostPublic
  postB: QueueItemPostPublic
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则按 dimension 流式采样。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: string }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'color')

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
const totalLabel = computed(() => (props.queue ? `${doneCount.value} / ${props.queue.total}` : `本次已判 ${doneCount.value}`))
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)
const seenKeys = new Set<string>()
let shownAt = performance.now()

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) {
    return
  }
  try {
    let fresh: BufferItem[]
    if (props.queue) {
      const resp = await v2NextPairwise({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
      const known = new Set(buffer.value.map(i => i.position))
      fresh = (resp.data ?? []).filter(i => !known.has(i.position)).map(i => ({ postA: i.postA, postB: i.postB, position: i.position }))
    }
    else {
      const resp = await v2SamplePairwise({ query: { limit: 20 } })
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
    if (fresh.length === 0) {
      exhausted.value = true
    }
  }
  catch (error) {
    handleAPIError(error, '加载图片失败')
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
        queue_id: props.queue?.id ?? null,
        queue_position: item.position ?? null,
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

watch(() => [props.queue?.id, props.dimension] as const, () => {
  buffer.value = []
  seenKeys.clear()
  exhausted.value = false
  doneCount.value = props.queue?.done ?? 0
  shownAt = performance.now()
  refill()
}, { immediate: true })

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL({ filePath: p.filePath, fileName: p.fileName, extension: p.extension, sha256: p.sha256 })
}

const title = computed(() => props.queue?.name ?? '流式对比')
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="text-sm px-3 py-2 p-divider flex items-center justify-between">
      <span>{{ title }} · <b>{{ dimension }}</b> 哪边更好？</span>
      <span class="text-fg-muted">{{ totalLabel }} · ← 左 · → 右 · ↓ 平 · Space 跳过 · Esc 退出</span>
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
      {{ exhausted ? '没有更多待判图片了 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
