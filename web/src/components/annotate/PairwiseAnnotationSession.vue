<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2CountPairwise, v2NextPairwise, v2SamplePairwise, v2SubmitPairwise } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

interface BufferItem {
  postA: QueueItemPostPublic
  postB: QueueItemPostPublic
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则按 dimension 流式采样。
// strategy 仅流式有效：similar = 内容相似 + 旧分相近的对子（默认），random = 全库随机。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: string, strategy?: 'random' | 'similar' | 'close' }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'color')

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
const seenKeys = new Set<string>()
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
      const resp = await v2SamplePairwise({ query: { limit: 20, strategy: props.strategy ?? 'similar' } })
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
    preloadAhead()
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
    if (winner !== 'skip' && cumulativeCount.value != null) {
      cumulativeCount.value += 1 // 乐观递增，与后端 total（decisive+tie）口径一致
    }
    shownAt = performance.now()
    preloadAhead()
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
  refreshCumulative()
}, { immediate: true })

const title = computed(() => props.queue?.name ?? '流式对比')

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
        <span class="pairwise-hotkeys"><kbd>↓</kbd> 平手 <kbd>Space</kbd> 跳过 <kbd>Esc</kbd> 退出</span>
      </div>
    </div>

    <!-- 维度问题横幅 -->
    <div class="text-sm text-fg font-medium px-4 py-2 text-center p-divider shrink-0">
      {{ question }}
    </div>

    <div v-if="current" class="flex flex-1 gap-1 min-h-0">
      <button class="pairwise-side group" title="选左边（←）" @click="judge('a')">
        <img :key="current.postA.id" :src="imgURL(current.postA)" :alt="current.postA.fileName" class="max-h-full max-w-full object-contain" decoding="async">
        <span class="pairwise-side__pick"><kbd>←</kbd> 选这边</span>
      </button>
      <button class="pairwise-side group" title="选右边（→）" @click="judge('b')">
        <img :key="current.postB.id" :src="imgURL(current.postB)" :alt="current.postB.fileName" class="max-h-full max-w-full object-contain" decoding="async">
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
