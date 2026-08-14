<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextListwise, v2SampleListwise, v2SubmitListwise, v2UndoAnnotations } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { prependEntry, pushCommand, removeEntries } from '@/shared'
import { getPostImageURL } from '@/utils'

interface BufferItem {
  posts: QueueItemPostPublic[]
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则流式采样。
// 每组是同一 silva 分窗口里视觉铺开的 ~size 张图；排一组 = C(size,2) 个边界对。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: string, size?: number }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()
const queryClient = useQueryClient()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'overall')
const groupSize = computed(() => props.size ?? 8)

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)

// 点击定序：picked 是"最好在前"的 post_id 序列，点一张排进去，再点一张取消。
const picked = ref<number[]>([])
const rankOf = computed(() => new Map(picked.value.map((pid, i) => [pid, i + 1])))
const complete = computed(() => current.value != null && picked.value.length === current.value.posts.length)

const seenKeys = new Set<string>()
let emptyStreak = 0
let shownAt = performance.now()

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL({ filePath: p.filePath, fileName: p.fileName, extension: p.extension, sha256: p.sha256 })
}

// 预热下一组：排当前组的十几秒里，下一组已进浏览器缓存。
const preloaded = new Set<string>()
function preloadAhead() {
  for (const item of buffer.value.slice(1, 2)) {
    for (const p of item.posts) {
      const url = imgURL(p)
      if (!preloaded.has(url)) {
        preloaded.add(url)
        const img = new Image()
        img.src = url
      }
    }
  }
}

// 一组要看 ~8 张、排 ~15 秒，水位 2 已绰绰有余；采样一批 3 组本身要跑分数窗口查询。
const LOW_WATER = 2
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

async function refillOnce(): Promise<void> {
  try {
    let fresh: BufferItem[]
    if (props.queue) {
      const resp = await v2NextListwise({ path: { queue_id: props.queue.id }, query: { limit: 10 } })
      const known = new Set(buffer.value.map(i => i.position))
      fresh = (resp.data ?? []).filter(i => !known.has(i.position)).map(i => ({ posts: i.posts, position: i.position }))
    }
    else {
      const resp = await v2SampleListwise({ query: { limit: 3, size: groupSize.value, dimension: dimension.value } })
      fresh = (resp.data ?? [])
        .map(g => ({ posts: g.posts }))
        .filter((g) => {
          const key = g.posts.map(p => p.id).join('-')
          if (seenKeys.has(key)) {
            return false
          }
          seenKeys.add(key)
          return true
        })
    }
    buffer.value.push(...fresh)
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
    handleAPIError(error, '加载图片组失败')
  }
}

function toggle(pid: number) {
  if (submitting.value) {
    return
  }
  picked.value = rankOf.value.has(pid) ? picked.value.filter(x => x !== pid) : [...picked.value, pid]
}

async function postRanking(item: BufferItem, ranking: number[], elapsedMs: number): Promise<number[]> {
  const resp = await v2SubmitListwise({
    body: {
      post_ids: item.posts.map(p => p.id),
      ranking,
      dimension: dimension.value,
      rubric_version: `${dimension.value}-v1`,
      session_id: sessionId,
      elapsed_ms: elapsedMs,
      queue_id: props.queue?.id ?? null,
      queue_position: item.position ?? null,
    },
  })
  return resp.data?.ids ?? []
}

function advancePast() {
  buffer.value.shift()
  picked.value = []
  doneCount.value += 1
  shownAt = performance.now()
  preloadAhead()
  void refill()
}

function noteInHistory(item: BufferItem, ranking: number[], ids: number[]) {
  const winner = item.posts.find(p => p.id === (ranking[0] ?? item.posts[0]!.id))
  if (ids[0] != null && winner) {
    prependEntry(queryClient, { kind: 'listwise', id: ids[0], post: winner, dimension: dimension.value, ranking: JSON.stringify(ranking) })
  }
}

// 与 pairwise 相同的撤销契约：真删事件行（误排会直接进训练导出），再把组塞回屏幕。
function recordRanking(item: BufferItem, ranking: number[], elapsedMs: number, ids: number[]) {
  const judgedIn = dimension.value
  let eventIds = ids
  pushCommand({
    label: ranking.length ? '排序一组' : '跳过一组',
    postIds: [],
    apply: async () => {
      eventIds = await postRanking(item, ranking, elapsedMs)
      advancePast()
      noteInHistory(item, ranking, eventIds)
    },
    revert: async () => {
      await v2UndoAnnotations({
        body: {
          kind: 'listwise',
          ids: eventIds,
          session_id: sessionId,
          queue_id: props.queue?.id ?? null,
          queue_position: item.position ?? null,
        },
      })
      removeEntries(queryClient, 'listwise', eventIds)
      if (dimension.value !== judgedIn) {
        return
      }
      buffer.value.unshift(item)
      picked.value = ranking
      exhausted.value = false
      doneCount.value -= 1
      shownAt = performance.now()
    },
  })
}

async function submit(ranking: number[]) {
  const item = current.value
  if (!item || submitting.value) {
    return
  }
  submitting.value = true
  const elapsedMs = Math.round(performance.now() - shownAt)
  try {
    const ids = await postRanking(item, ranking, elapsedMs)
    advancePast()
    noteInHistory(item, ranking, ids)
    recordRanking(item, ranking, elapsedMs, ids)
  }
  catch (error) {
    handleAPIError(error, '提交失败')
  }
  finally {
    submitting.value = false
  }
}

onKeyStroke('Enter', (e) => {
  if (!complete.value) {
    return
  }
  e.preventDefault()
  submit(picked.value)
})
onKeyStroke(' ', (e) => {
  if (!current.value) {
    return
  }
  e.preventDefault()
  submit([]) // skip：这组问过了，但没有排序信息
})
onKeyStroke('Backspace', (e) => {
  if (!picked.value.length) {
    return
  }
  e.preventDefault()
  picked.value = picked.value.slice(0, -1)
})
onKeyStroke('Escape', (e) => {
  e.preventDefault()
  emit('exit')
})

watch(() => [props.queue?.id, props.dimension] as const, () => {
  buffer.value = []
  picked.value = []
  seenKeys.clear()
  emptyStreak = 0
  exhausted.value = false
  doneCount.value = props.queue?.done ?? 0
  shownAt = performance.now()
  refill()
}, { immediate: true })

const title = computed(() => props.queue?.name ?? '流式排序')
const totalLabel = computed(() => (props.queue ? `${doneCount.value} / ${props.queue.total}` : `本次 ${doneCount.value} 组`))
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button class="listwise-exit" title="退出（Esc）" @click="emit('exit')">
          <i class="i-tabler-arrow-left" />
        </button>
        <span class="text-fg font-medium truncate">{{ title }}</span>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <span class="listwise-hotkeys"><kbd>点击</kbd> 依次排名 <kbd>⌫</kbd> 收回一名 <kbd>Enter</kbd> 提交 <kbd>Space</kbd> 跳过 <kbd>Esc</kbd> 退出</span>
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <div class="text-sm text-fg font-medium px-4 py-2 text-center p-divider shrink-0">
        按喜欢程度依次点击 —— 先点最好的<template v-if="current">
          （已排 {{ picked.length }} / {{ current.posts.length }}<template v-if="complete">
            ，<kbd class="listwise-kbd">Enter</kbd> 提交
          </template>）
        </template>
      </div>

      <div v-if="current" class="listwise-grid flex-1 min-h-0">
        <button
          v-for="p in current.posts"
          :key="p.id"
          class="listwise-cell"
          :class="{ 'listwise-cell--ranked': rankOf.has(p.id) }"
          @click="toggle(p.id)"
        >
          <img :src="imgURL(p)" :alt="p.fileName" class="max-h-full max-w-full object-contain" decoding="async">
          <span v-if="rankOf.has(p.id)" class="listwise-cell__rank">{{ rankOf.get(p.id) }}</span>
        </button>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            没有更多待排组了
          </div>
          <div class="text-xs text-fg-muted mt-1">
            本次共排序 {{ doneCount }} 组
          </div>
        </div>
        <div v-else class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="listwise-spinner" />加载中…
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.listwise-exit {
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
.listwise-exit:hover {
  background: rgb(var(--p-primary-rgb) / 0.12);
  color: var(--p-fg);
}

.listwise-hotkeys kbd,
.listwise-kbd {
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

.listwise-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: 1fr;
  gap: 4px;
  padding: 4px;
}

.listwise-cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: none;
  background: var(--p-bg);
  cursor: pointer;
}
.listwise-cell::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border: 2px solid transparent;
  transition: border-color var(--p-transition-fast);
}
.listwise-cell:hover::after {
  border-color: rgb(var(--p-primary-rgb) / 0.6);
}
.listwise-cell--ranked::after {
  border-color: rgb(var(--p-primary-rgb) / 0.85);
}
.listwise-cell--ranked img {
  opacity: 0.75;
}

.listwise-cell__rank {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: var(--p-text-sm);
  font-weight: var(--p-weight-semibold);
  border-radius: var(--p-radius-full);
  background: var(--p-primary);
  color: white;
}

.listwise-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--p-border);
  border-top-color: var(--p-primary);
  border-radius: 50%;
  animation: listwise-spin 0.7s linear infinite;
}
@keyframes listwise-spin {
  to { transform: rotate(360deg); }
}
</style>
