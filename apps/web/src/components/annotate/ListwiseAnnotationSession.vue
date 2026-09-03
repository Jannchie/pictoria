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
const groupSize = computed(() => props.size ?? 6)

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)

// 一字排开、拖拽定序：order 是当前行序（post_id，左 = 最好），初始 = 呈现顺序。
// 呈现顺序由服务端随机化并存进 post_ids，留作顺序效应审计。
const order = ref<number[]>([])
const touched = ref(false) // 至少拖动过一次才认为这是判断而不是初始随机序
const confirmArmed = ref(false) // 未调整时 Enter 需要按两次，防止把随机序当标注提交
const postById = computed(() => new Map((current.value?.posts ?? []).map(p => [p.id, p])))

const seenKeys = new Set<string>()
let emptyStreak = 0
let shownAt = performance.now()

/** 组的身份 = 成员 id 序列。既用于批次去重，也进卡片的 :key（换组必须重建 <img>）。 */
function groupKeyOf(posts: QueueItemPostPublic[]): string {
  return posts.map(p => p.id).join('-')
}

function imgURL(p: QueueItemPostPublic) {
  return getPostImageURL(p)
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

// 一组要看 ~6 张、排 ~15 秒，水位 2 已绰绰有余；采样一批 3 组本身要跑分数窗口查询。
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
          const key = groupKeyOf(g.posts)
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

// ── 忙碌态 ──────────────────────────────────────────────────────
// 按下 Enter 到下一组能看之间有两段静默：提交请求在飞（旧组还挂在屏上，屏幕毫无变化，
// 不知道按没按上），以及新一组的图还没解码完。两段都算「还没轮到你排」。
// 组身份进 :key，换组必然重建 <img>，@load 一定会再触发一次 —— 否则复用旧节点会让
// 加载态永远退不掉。
const loadedIds = ref(new Set<number>())
const groupKey = computed(() => groupKeyOf(current.value?.posts ?? []))
const imagesReady = computed(() => order.value.every(id => loadedIds.value.has(id)))
const busy = computed(() => submitting.value || !imagesReady.value)
const busyLabel = computed(() => (submitting.value ? '提交中…' : '加载中…'))

function markLoaded(pid: number) {
  loadedIds.value.add(pid)
}

// ── 大图查看 ────────────────────────────────────────────────────
const lightbox = ref<number | null>(null)
const lightboxPost = computed(() => (lightbox.value == null ? null : postById.value.get(lightbox.value) ?? null))
const lightboxIndex = computed(() => (lightbox.value == null ? -1 : order.value.indexOf(lightbox.value)))

function lightboxStep(delta: number) {
  const next = lightboxIndex.value + delta
  if (next >= 0 && next < order.value.length) {
    lightbox.value = order.value[next]!
  }
}

// ── 拖拽排序（pointer 事件，无依赖）─────────────────────────────
// 拖动中不改 order：被拖卡片跟手，其余卡片按目标位算出让位平移；松手才 splice。
const GAP = 8
interface DragState {
  id: number
  from: number
  to: number
  startX: number
  startY: number
  dx: number
  dy: number
  step: number
  moved: boolean
}
const drag = ref<DragState | null>(null)

function onPointerDown(e: PointerEvent, pid: number) {
  if (submitting.value || (e.pointerType === 'mouse' && e.button !== 0)) {
    return
  }
  const idx = order.value.indexOf(pid)
  if (idx === -1) {
    return
  }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag.value = { id: pid, from: idx, to: idx, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, step: 0, moved: false }
}

function onPointerMove(e: PointerEvent) {
  const d = drag.value
  if (!d) {
    return
  }
  d.dx = e.clientX - d.startX
  d.dy = e.clientY - d.startY
  if (!d.moved) {
    if (Math.hypot(d.dx, d.dy) < 6) {
      return
    }
    d.moved = true
    d.step = (e.currentTarget as HTMLElement).getBoundingClientRect().width + GAP
  }
  d.to = Math.min(order.value.length - 1, Math.max(0, d.from + Math.round(d.dx / d.step)))
}

function onPointerUp() {
  const d = drag.value
  if (!d) {
    return
  }
  drag.value = null
  if (!d.moved) {
    lightbox.value = d.id
    return
  }
  if (d.to !== d.from) {
    const next = [...order.value]
    next.splice(d.to, 0, ...next.splice(d.from, 1))
    order.value = next
  }
  touched.value = true
  confirmArmed.value = false
}

function onPointerCancel() {
  drag.value = null
}

// 拖动中每张卡的视觉位置（0 起）：被拖的在目标位，被跨过的让一位。
function displayIndex(idx: number): number {
  const d = drag.value
  if (!d?.moved) {
    return idx
  }
  if (idx === d.from) {
    return d.to
  }
  if (d.from < d.to && idx > d.from && idx <= d.to) {
    return idx - 1
  }
  if (d.from > d.to && idx >= d.to && idx < d.from) {
    return idx + 1
  }
  return idx
}

// 拖动位移全部夹在行内：横向到首尾格位为止，纵向只留 8px 跟手余量（正好是行的
// padding）。被拖的卡不放大 —— 满高的卡片放大 2% 会顶出行外，把祖先的 overflow-y-auto
// 撑出一条滚动条；「拿起来」的反馈交给 .listwise-card--drag 的高亮边框和投影。
const DRAG_LIFT = 8

function cardStyle(pid: number, idx: number): Record<string, string> {
  const d = drag.value
  if (!d?.moved) {
    return {}
  }
  if (pid === d.id) {
    const x = Math.min((order.value.length - 1 - d.from) * d.step, Math.max(-d.from * d.step, d.dx))
    const y = Math.min(DRAG_LIFT, Math.max(-DRAG_LIFT, d.dy * 0.25))
    return { transform: `translate(${x}px, ${y}px)` }
  }
  const shift = displayIndex(idx) - idx
  return shift ? { transform: `translateX(${shift * d.step}px)` } : {}
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
    label: ranking.length > 0 ? '排序一组' : '跳过一组',
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
      order.value = ranking.length > 0 ? [...ranking] : item.posts.map(p => p.id)
      touched.value = ranking.length > 0
      confirmArmed.value = false
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
  if (!current.value) {
    return
  }
  e.preventDefault()
  if (lightbox.value != null) {
    lightbox.value = null
    return
  }
  // 一次没拖过就提交，多半是误触 —— 初始序是随机呈现序，直接进库会污染数据。
  if (!touched.value && !confirmArmed.value) {
    confirmArmed.value = true
    return
  }
  submit(order.value)
})
onKeyStroke(' ', (e) => {
  if (!current.value || lightbox.value != null) {
    return
  }
  e.preventDefault()
  submit([]) // skip：这组问过了，但没有排序信息
})
onKeyStroke('ArrowLeft', (e) => {
  if (lightbox.value == null) {
    return
  }
  e.preventDefault()
  lightboxStep(-1)
})
onKeyStroke('ArrowRight', (e) => {
  if (lightbox.value == null) {
    return
  }
  e.preventDefault()
  lightboxStep(1)
})
onKeyStroke('Escape', (e) => {
  e.preventDefault()
  if (lightbox.value != null) {
    lightbox.value = null
    return
  }
  emit('exit')
})

// 组变化时重置行序为呈现顺序；undo 已按提交序恢复过的组（成员集相同）不重置。
watch(current, (cur) => {
  const ids = cur?.posts.map(p => p.id) ?? []
  const same = ids.length === order.value.length && ids.every(id => order.value.includes(id))
  if (!same) {
    order.value = ids
    touched.value = false
    confirmArmed.value = false
    loadedIds.value.clear()
  }
  lightbox.value = null
  drag.value = null
})

watch(() => [props.queue?.id, props.dimension] as const, () => {
  buffer.value = []
  order.value = []
  touched.value = false
  confirmArmed.value = false
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
        <span class="listwise-hotkeys"><kbd>拖拽</kbd> 排序 <kbd>点击</kbd> 大图 <kbd>Enter</kbd> 提交 <kbd>Space</kbd> 跳过 <kbd>Esc</kbd> 退出</span>
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <div class="text-sm font-medium px-4 py-2 text-center p-divider shrink-0" :class="confirmArmed ? 'listwise-confirm' : 'text-fg'">
        <template v-if="confirmArmed">
          还没有调整过顺序 —— 再按一次 <kbd class="listwise-kbd">Enter</kbd> 按当前顺序提交
        </template>
        <template v-else>
          左右拖拽排序 —— 最喜欢的放最左，点击看大图<template v-if="touched">
            ，<kbd class="listwise-kbd">Enter</kbd> 提交
          </template>
        </template>
      </div>

      <div v-if="current" class="listwise-row flex-1 min-h-0" :class="{ 'listwise-row--submitting': submitting }">
        <div
          v-for="(pid, idx) in order"
          :key="`${groupKey}:${pid}`"
          class="listwise-card"
          :class="{ 'listwise-card--drag': drag?.moved && drag.id === pid }"
          :style="cardStyle(pid, idx)"
          @pointerdown="onPointerDown($event, pid)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerCancel"
          @dragstart.prevent
        >
          <img
            v-if="postById.get(pid)"
            :src="imgURL(postById.get(pid)!)"
            :alt="postById.get(pid)!.fileName"
            class="max-h-full max-w-full object-contain"
            decoding="async"
            draggable="false"
            @load="markLoaded(pid)"
            @error="markLoaded(pid)"
          >
          <span class="listwise-card__rank" :class="{ 'listwise-card__rank--best': displayIndex(idx) === 0 }">{{ displayIndex(idx) + 1 }}</span>
        </div>

        <!-- 提交/解码快的时候不该闪一下：动画带 160ms 延迟，短等待里它根本不出现 -->
        <div v-if="busy" class="listwise-busy">
          <span class="listwise-spinner" />{{ busyLabel }}
        </div>
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

    <!-- 大图查看：点击（非拖拽）打开，←/→ 按当前行序切换 -->
    <div v-if="lightboxPost" class="listwise-lightbox" @click.self="lightbox = null">
      <img :src="imgURL(lightboxPost)" :alt="lightboxPost.fileName" class="listwise-lightbox__img" draggable="false">
      <div class="listwise-lightbox__bar">
        <span class="text-fg font-medium tabular-nums">第 {{ lightboxIndex + 1 }} 位 / {{ order.length }}</span>
        <span class="text-fg-muted"><kbd>←</kbd><kbd>→</kbd> 切换 <kbd>Esc</kbd> 关闭</span>
      </div>
      <button v-if="lightboxIndex > 0" class="listwise-lightbox__nav listwise-lightbox__nav--left" @click="lightboxStep(-1)">
        <i class="i-tabler-chevron-left" />
      </button>
      <button v-if="lightboxIndex < order.length - 1" class="listwise-lightbox__nav listwise-lightbox__nav--right" @click="lightboxStep(1)">
        <i class="i-tabler-chevron-right" />
      </button>
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
.listwise-kbd,
.listwise-lightbox__bar kbd {
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

.listwise-confirm {
  color: var(--p-warning);
}

.listwise-row {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 8px;
  /* 拖动中的卡片是 transform 平移出来的，不裁掉就会把祖先容器撑出滚动条 */
  overflow: hidden;
}

/* 提交中：这组已经交出去了，压暗并停掉拖拽。图片解码的等待不压暗 —— 那时候卡片还能看能拖。 */
.listwise-row--submitting .listwise-card {
  pointer-events: none;
  animation: listwise-dim var(--p-transition-fast) ease 160ms forwards;
}
@keyframes listwise-dim {
  to { opacity: 0.45; }
}

.listwise-busy {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 10;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  font-size: var(--p-text-sm);
  border-radius: var(--p-radius-full);
  background: var(--p-surface-3);
  color: var(--p-fg);
  pointer-events: none;
  transform: translate(-50%, -50%);
  opacity: 0;
  animation: listwise-busy-in var(--p-transition-fast) ease 160ms forwards;
}
@keyframes listwise-busy-in {
  to { opacity: 1; }
}

.listwise-card {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--p-bg);
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: transform 0.18s ease;
}
.listwise-card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border: 2px solid transparent;
  transition: border-color var(--p-transition-fast);
}
.listwise-card:hover::after {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
}
.listwise-card--drag {
  z-index: 10;
  cursor: grabbing;
  transition: none;
}
.listwise-card--drag::after {
  border-color: rgb(var(--p-primary-rgb) / 0.85);
}
.listwise-card--drag img {
  filter: drop-shadow(0 8px 24px rgb(0 0 0 / 0.45));
}

.listwise-card__rank {
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
  background: var(--p-surface-3);
  color: var(--p-fg);
  pointer-events: none;
}
.listwise-card__rank--best {
  background: var(--p-primary);
  color: white;
}

.listwise-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--p-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.85);
}
.listwise-lightbox__img {
  max-width: 94vw;
  max-height: 92vh;
  object-fit: contain;
}
.listwise-lightbox__bar {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 6px 14px;
  font-size: var(--p-text-xs);
  border-radius: var(--p-radius-full);
  background: rgb(0 0 0 / 0.55);
  color: white;
}
.listwise-lightbox__bar .text-fg,
.listwise-lightbox__bar .text-fg-muted {
  color: rgb(255 255 255 / 0.85);
}
.listwise-lightbox__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  font-size: 22px;
  border: none;
  border-radius: var(--p-radius-full);
  background: rgb(0 0 0 / 0.45);
  color: white;
  cursor: pointer;
  transition: background-color var(--p-transition-fast);
}
.listwise-lightbox__nav:hover {
  background: rgb(0 0 0 / 0.7);
}
.listwise-lightbox__nav--left {
  left: 18px;
}
.listwise-lightbox__nav--right {
  right: 18px;
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
