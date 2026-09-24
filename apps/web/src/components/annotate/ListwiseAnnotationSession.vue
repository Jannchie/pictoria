<script setup lang="ts">
import type { QueueItemPostPublic, QueueSummaryPublic } from '@/api'
import type { AnnotationDimension } from '@/shared/annotationTypes'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2NextListwise, v2SampleListwise, v2SubmitListwise, v2UndoAnnotations } from '@/api'
import AnnotationKeyHints from '@/components/annotate/AnnotationKeyHints.vue'
import { isForeignComposite, moveItem, noLayerOpen, sortableIntent, sortableTarget, useProgressAnnouncer } from '@/composables/useAnnotationKeymap'
import { useAPIError } from '@/composables/useAPIError'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useHotkey } from '@/composables/useHotkey'
import { useRovingFocus } from '@/composables/useRovingFocus'
import { formatNumber } from '@/locale'
import { announce, prependEntry, pushCommand, removeEntries, useLayer } from '@/shared'
import { getPostImageURL } from '@/utils'
import { focusElement } from '@/utils/focus'
import { formatShortcut, isMac } from '@/utils/keyboard'

interface BufferItem {
  posts: QueueItemPostPublic[]
  /** 与 posts 同序的 silva 分，流式采样才有（queue 模式的固定批次不带分）。 */
  silva?: (number | null)[]
  position?: number // queue 模式才有
}

// queue 与 dimension 二选一：有 queue 走固定批次，否则流式采样。
// 每组是同一 silva 分窗口里视觉铺开的 ~size 张图；排一组 = C(size,2) 个边界对。
const props = defineProps<{ queue?: QueueSummaryPublic, dimension?: AnnotationDimension, size?: number, repeat?: number }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()
const { t } = useI18n()
const queryClient = useQueryClient()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue?.dimensions[0] ?? props.dimension ?? 'overall')
const groupSize = computed(() => props.size ?? 4)

const buffer = ref<BufferItem[]>([])
const doneCount = ref(props.queue?.done ?? 0)
const totalLabel = computed(() => (props.queue
  ? t('annotate.progress.queue', { done: formatNumber(doneCount.value), total: formatNumber(props.queue.total) })
  : t('annotate.progress.listwise', { n: formatNumber(doneCount.value) })))
const announceProgress = useProgressAnnouncer(() => (props.queue
  ? t('annotate.progress.queueAnnounce', { done: formatNumber(doneCount.value), total: formatNumber(props.queue.total) })
  : t('annotate.progress.listwiseAnnounce', { n: formatNumber(doneCount.value) })))
const exhausted = ref(false)
const submitting = ref(false)
const current = computed(() => buffer.value[0] ?? null)

// 一字排开、拖拽定序：order 是当前行序（post_id，左 = 最好），初始 = 呈现顺序。
// 呈现顺序由服务端随机化并存进 postIds，留作顺序效应审计。
const order = ref<number[]>([])
const touched = ref(false) // 至少拖动过一次才认为这是判断而不是初始随机序
const confirmArmed = ref(false) // 未调整时 Enter 需要按两次，防止把随机序当标注提交
// Keyboard pick-up (see the Keyboard section): the card being moved, and the order to
// restore on Escape.
interface Grab { id: number, original: number[], touched: boolean }
const grabbed = ref<Grab | null>(null)
const postById = computed(() => new Map((current.value?.posts ?? []).map(p => [p.id, p])))

// ── 与模型的一致率 ──────────────────────────────────────────────
// 「模型学到的顺序如何」直接量出来，而不是让你从拖了几下去猜。分数只在**提交之后**
// 参与统计：呈现顺序仍然随机，图上也不显示分数 —— 看见模型的答案会系统性地把判断
// 拉向它（anchoring），那比随机的位置惰性坏得多，而且事后无法从数据里减掉。
//
// 累计而不是逐组：一组 4 张只有 6 对，54% 和 65% 在这个样本量下肉眼完全分不出；
// 十几组之后这个数才稳得下来。
const agreeOk = ref(0)
const agreeTotal = ref(0)
const agreeLabel = computed(() => (agreeTotal.value > 0 ? `${Math.round((agreeOk.value / agreeTotal.value) * 100)}%` : null))

/**
 * 这一组里你和 silva 方向相同的对数 / 可比的对数。
 *
 * 同分对不计 —— 模型没有表态，谈不上一致或不一致；skip（ranking 为空）同理不计。
 */
function agreementOf(item: BufferItem, ranking: number[]): [number, number] {
  if (!item.silva || ranking.length < 2) {
    return [0, 0]
  }
  const score = new Map(item.posts.map((p, i) => [p.id, item.silva![i] ?? null]))
  let ok = 0
  let total = 0
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      const a = score.get(ranking[i]!)
      const b = score.get(ranking[j]!)
      if (a == null || b == null || a === b) {
        continue
      }
      total++
      if (a > b) { // 你排在前 = 你认为更好；silva 分更高 = 模型认为更好
        ok++
      }
    }
  }
  return [ok, total]
}

/** 提交时 +1、撤销时 -1，让顶栏那个数始终等于**当前留在库里**的那些组。 */
function applyAgreement(item: BufferItem, ranking: number[], sign: 1 | -1) {
  const [ok, total] = agreementOf(item, ranking)
  agreeOk.value += sign * ok
  agreeTotal.value += sign * total
}

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
      const resp = await v2SampleListwise({ query: { limit: 3, size: groupSize.value, dimension: dimension.value, repeat: props.repeat } })
      fresh = (resp.data ?? [])
        .map(g => ({ posts: g.posts, silva: g.silva }))
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
    handleAPIError(error, t('annotate.error.loadGroups'))
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
const busyLabel = computed(() => (submitting.value ? t('annotate.session.submitting') : t('common.loading')))

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
    announce(t('annotate.listwise.viewPosition', { pos: next + 1, total: order.value.length }))
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
  grabbed.value = null // the pointer takes over from a keyboard pick-up
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
      postIds: item.posts.map(p => p.id),
      ranking,
      dimension: dimension.value,
      rubricVersion: `${dimension.value}-v1`,
      sessionId,
      elapsedMs,
      queueId: props.queue?.id ?? null,
      queuePosition: item.position ?? null,
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
  announceProgress()
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
    label: t(ranking.length > 0 ? 'annotate.listwise.rankGroup' : 'annotate.listwise.skipGroup'),
    postIds: [],
    apply: async () => {
      eventIds = await postRanking(item, ranking, elapsedMs)
      advancePast()
      noteInHistory(item, ranking, eventIds)
      applyAgreement(item, ranking, 1)
    },
    revert: async () => {
      await v2UndoAnnotations({
        body: {
          kind: 'listwise',
          ids: eventIds,
          sessionId,
          queueId: props.queue?.id ?? null,
          queuePosition: item.position ?? null,
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
      applyAgreement(item, ranking, -1)
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
    applyAgreement(item, ranking, 1)
    recordRanking(item, ranking, elapsedMs, ids)
  }
  catch (error) {
    handleAPIError(error, t('annotate.error.submit'))
  }
  finally {
    submitting.value = false
  }
}

// ── Keyboard ────────────────────────────────────────────────────────────────
// Session keys go through useHotkey (exact modifiers, nothing while typing or while a
// layer — the palette, help, this session's own lightbox — is open).
//
// The cards are an APG-style sortable list: one Tab stop (roving, ←/→ move focus),
// Space/Enter pick a card up, arrows move it, Space/Enter drop, Escape cancels,
// Alt+↑/↓ move without picking up, V enlarges. Every move is announced. While a card
// has focus, Enter/Space belong to it, so the order is submitted with Mod+Enter (or
// the Submit button); from anywhere else plain Enter still submits.
const root = useTemplateRef<HTMLElement>('root')
const row = useTemplateRef<HTMLElement>('row')
const notForeign = (e: KeyboardEvent) => isForeignComposite(e.target, root.value)
const helpId = useId()

useRovingFocus({ container: row, itemSelector: '[data-sort-card]', orientation: 'horizontal', pageSize: false })

// A keyed v-for reorder may move the focused card's DOM node, which blurs it; the
// focusout that causes must not read as "the user left the card".
let refocusing = false

function cardEl(pid: number): HTMLElement | null {
  return row.value?.querySelector<HTMLElement>(`[data-pid="${pid}"]`) ?? null
}

function positionArgs(pid: number) {
  return { name: postById.value.get(pid)?.fileName ?? '', pos: order.value.indexOf(pid) + 1, total: order.value.length }
}

function refocusCard(pid: number) {
  refocusing = true
  void nextTick(() => {
    focusElement(cardEl(pid))
    refocusing = false
  })
}

function moveCard(pid: number, to: number) {
  const from = order.value.indexOf(pid)
  if (from === -1) {
    return
  }
  if (to !== from) {
    order.value = moveItem(order.value, from, to)
    touched.value = true
    confirmArmed.value = false
    refocusCard(pid)
  }
  announce(t('annotate.listwise.moved', positionArgs(pid)))
}

function onCardKeydown(e: KeyboardEvent, pid: number) {
  if (submitting.value) {
    return
  }
  const intent = sortableIntent(e, grabbed.value?.id === pid)
  if (!intent || (e.repeat && (intent === 'grab' || intent === 'drop' || intent === 'cancel' || intent === 'view'))) {
    return
  }
  e.preventDefault()
  switch (intent) {
    case 'grab': {
      grabbed.value = { id: pid, original: [...order.value], touched: touched.value }
      announce(t('annotate.listwise.grabbed', positionArgs(pid)))
      break
    }
    case 'drop': {
      grabbed.value = null
      announce(t('annotate.listwise.dropped', positionArgs(pid)))
      break
    }
    case 'cancel': {
      const g = grabbed.value!
      grabbed.value = null
      order.value = g.original
      touched.value = g.touched
      refocusCard(pid)
      announce(t('annotate.listwise.cancelled', positionArgs(pid)))
      break
    }
    case 'view': {
      lightbox.value = pid
      break
    }
    default: {
      moveCard(pid, sortableTarget(intent, order.value.indexOf(pid), order.value.length))
    }
  }
}

// Tabbing / clicking away from a picked-up card puts it down where it is.
function onCardFocusout(pid: number) {
  if (!refocusing && grabbed.value?.id === pid) {
    grabbed.value = null
  }
}

function trySubmit() {
  if (!current.value) {
    return
  }
  // 一次没拖过就提交，多半是误触 —— 初始序是随机呈现序，直接进库会污染数据。
  if (!touched.value && !confirmArmed.value) {
    confirmArmed.value = true
    announce(t('annotate.listwise.confirm', { enter: 'Enter' }))
    return
  }
  grabbed.value = null
  submit(order.value)
}

function skipGroup() {
  if (!current.value) {
    return
  }
  grabbed.value = null
  submit([]) // skip：这组问过了，但没有排序信息
}

const canAct = () => noLayerOpen() && !!current.value
useHotkey('Enter', trySubmit, { when: canAct, ignore: notForeign, repeat: false })
useHotkey('Mod+Enter', trySubmit, { when: canAct, allowInWidgets: true, ignore: notForeign, repeat: false })
useHotkey('Space', skipGroup, { when: canAct, ignore: notForeign, repeat: false })
useHotkey('Escape', () => emit('exit'), { when: noLayerOpen, allowInWidgets: true, ignore: notForeign })

// ── Lightbox: a modal dialog on the layer stack ─────────────────────────────
const lightboxEl = useTemplateRef<HTMLElement>('lightboxEl')
const lightboxOpen = computed(() => lightboxPost.value != null)
function closeLightbox() {
  lightbox.value = null
}
const { isTop: lightboxOnTop } = useLayer(lightboxOpen, { el: () => lightboxEl.value, modal: true, onEscape: closeLightbox })
// Opened from a card by keyboard → focus goes back to that card. Opened by a click
// (cards never take focus from the mouse) → back to the session, not <body>.
useFocusTrap(lightboxEl, lightboxOpen, { initialFocus: 'container', returnFocus: () => root.value })
const lightboxActive = () => lightboxOpen.value && lightboxOnTop.value
useHotkey(['ArrowLeft', 'ArrowRight'], e => lightboxStep(e.key === 'ArrowLeft' ? -1 : 1), { when: lightboxActive, allowInWidgets: true })
// Enter on the dialog itself closes it (as before); on a focused button it clicks it.
useHotkey('Enter', closeLightbox, { when: lightboxActive, repeat: false })

// The launcher that started the session is gone; keep focus off <body>.
onMounted(() => {
  const active = document.activeElement
  if (!active || active === document.body) {
    focusElement(root.value, { preventScroll: true })
  }
})

// 组变化时重置行序为呈现顺序；undo 已按提交序恢复过的组（成员集相同）不重置。
watch(current, (cur) => {
  // Focus was on a card of the group that is about to unmount: hand it to the next
  // group's first card (or the session) instead of letting it fall to <body>.
  const hadFocus = !!row.value?.contains(document.activeElement)
  if (hadFocus) {
    void nextTick(() => {
      const first = row.value?.querySelector<HTMLElement>('[data-sort-card]')
      focusElement(first ?? root.value)
    })
  }
  grabbed.value = null
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
  agreeOk.value = 0
  agreeTotal.value = 0
  shownAt = performance.now()
  refill()
}, { immediate: true })

const title = computed(() => props.queue?.name ?? t('annotate.listwise.streamTitle'))

watch(() => exhausted.value && !current.value, (done) => {
  if (done) {
    announce(t('annotate.session.exhaustedAnnounce'))
  }
})

const hints = computed(() => [
  { keys: [t('annotate.keys.drag')], label: t('annotate.keys.reorder') },
  { keys: [t('annotate.keys.click')], label: t('annotate.keys.enlarge') },
  { keys: ['Enter'], label: t('annotate.keys.submit') },
  { keys: ['Space'], label: t('annotate.keys.skip') },
  { keys: ['Esc'], label: t('annotate.keys.exit') },
])
const lightboxHints = computed(() => [
  { keys: ['←', '→'], label: t('annotate.keys.switch') },
  { keys: ['Esc'], label: t('annotate.keys.close') },
])
const submitKeyAria = isMac ? 'Meta+Enter' : 'Control+Enter'
</script>

<template>
  <div ref="root" class="listwise-session flex flex-col h-full" tabindex="-1" role="region" :aria-label="title">
    <!-- 顶栏 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <div class="flex gap-3 min-w-0 items-center">
        <button
          type="button"
          class="listwise-exit"
          :aria-label="$t('annotate.session.exit')"
          :title="$t('annotate.session.exitHint', { key: 'Esc' })"
          aria-keyshortcuts="Escape"
          @click="emit('exit')"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
        </button>
        <h2 class="text-fg font-medium truncate">
          {{ title }}
        </h2>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span class="text-fg font-medium tabular-nums">{{ totalLabel }}</span>
        <span
          v-if="agreeLabel"
          class="tabular-nums"
          :title="$t('annotate.listwise.agreementTitle', { n: formatNumber(agreeTotal) })"
        >{{ $t('annotate.listwise.agreement') }} <span class="text-fg font-medium">{{ agreeLabel }}</span></span>
        <AnnotationKeyHints :hints="hints" />
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <div class="text-sm font-medium px-4 py-2 text-center p-divider shrink-0" :class="confirmArmed ? 'listwise-confirm' : 'text-fg'">
        <i18n-t v-if="confirmArmed" keypath="annotate.listwise.confirm" tag="span" scope="global">
          <template #enter>
            <kbd class="listwise-kbd">Enter</kbd>
          </template>
        </i18n-t>
        <template v-else>
          {{ $t('annotate.listwise.instructions') }}<i18n-t v-if="touched" keypath="annotate.listwise.submitHint" tag="span" scope="global">
            <template #enter>
              <kbd class="listwise-kbd">Enter</kbd>
            </template>
          </i18n-t>
        </template>
        <span v-if="current" class="ml-3 align-middle inline-flex gap-1.5">
          <PButton size="xs" variant="subtle" :disabled="submitting" @mousedown.prevent @click="skipGroup">
            {{ $t('annotate.listwise.skip') }}
          </PButton>
          <PButton size="xs" variant="primary" :disabled="submitting" :aria-keyshortcuts="submitKeyAria" @mousedown.prevent @click="trySubmit">
            {{ $t('annotate.listwise.submit') }}
          </PButton>
        </span>
      </div>

      <div
        v-if="current"
        ref="row"
        class="listwise-row flex-1 min-h-0"
        :class="{ 'listwise-row--submitting': submitting }"
        role="group"
        :aria-label="$t('annotate.listwise.listLabel')"
      >
        <!-- @mousedown.prevent: a click never parks focus on a card, so Enter after a
             mouse drag still submits instead of picking the card up. -->
        <div
          v-for="(pid, idx) in order"
          :key="`${groupKey}:${pid}`"
          data-sort-card
          :data-pid="pid"
          role="button"
          :aria-roledescription="$t('annotate.listwise.sortable')"
          :aria-label="$t('annotate.listwise.cardLabel', { pos: idx + 1, total: order.length, name: postById.get(pid)?.fileName ?? '' })"
          :aria-describedby="helpId"
          class="listwise-card"
          :class="{ 'listwise-card--drag': (drag?.moved && drag.id === pid) || grabbed?.id === pid }"
          :style="cardStyle(pid, idx)"
          @mousedown.prevent
          @pointerdown="onPointerDown($event, pid)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerCancel"
          @dragstart.prevent
          @keydown="onCardKeydown($event, pid)"
          @focusout="onCardFocusout(pid)"
        >
          <img
            v-if="postById.get(pid)"
            :src="imgURL(postById.get(pid)!)"
            alt=""
            class="max-h-full max-w-full object-contain"
            decoding="async"
            draggable="false"
            @load="markLoaded(pid)"
            @error="markLoaded(pid)"
          >
          <span class="listwise-card__rank" :class="{ 'listwise-card__rank--best': displayIndex(idx) === 0 }" aria-hidden="true">{{ displayIndex(idx) + 1 }}</span>
        </div>
        <div :id="helpId" class="sr-only">
          {{ $t('annotate.listwise.sortHelp', { submitKey: formatShortcut('Mod+Enter') }) }}
        </div>

        <!-- 提交/解码快的时候不该闪一下：动画带 160ms 延迟，短等待里它根本不出现 -->
        <div v-if="busy" class="listwise-busy">
          <span class="listwise-spinner" aria-hidden="true" />{{ busyLabel }}
        </div>
      </div>

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <div v-if="exhausted" class="text-center">
          <div class="text-3xl mb-3" aria-hidden="true">
            🎉
          </div>
          <div class="text-sm text-fg font-medium">
            {{ $t('annotate.listwise.exhausted') }}
          </div>
          <div class="text-xs text-fg-muted mt-1">
            {{ $t('annotate.listwise.exhaustedDetail', { n: formatNumber(doneCount) }) }}
          </div>
        </div>
        <div v-else role="status" class="text-sm text-fg-muted flex gap-2 items-center">
          <span class="listwise-spinner" aria-hidden="true" />{{ $t('common.loading') }}
        </div>
      </div>
    </div>

    <!-- 大图查看：点击（非拖拽）或卡片上按 V 打开，←/→ 按当前行序切换 -->
    <Teleport to="body">
      <div
        v-if="lightboxPost"
        ref="lightboxEl"
        class="listwise-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('annotate.listwise.viewTitle')"
        tabindex="-1"
        @click.self="closeLightbox"
      >
        <img :src="imgURL(lightboxPost)" :alt="lightboxPost.fileName" class="listwise-lightbox__img" draggable="false">
        <div class="listwise-lightbox__bar">
          <span class="text-fg font-medium tabular-nums">{{ $t('annotate.listwise.viewPosition', { pos: lightboxIndex + 1, total: order.length }) }}</span>
          <AnnotationKeyHints class="text-fg-muted" :hints="lightboxHints" />
        </div>
        <button
          type="button"
          class="listwise-lightbox__btn listwise-lightbox__close"
          :aria-label="$t('annotate.listwise.viewClose')"
          :title="$t('annotate.listwise.viewClose')"
          aria-keyshortcuts="Escape"
          @click="closeLightbox"
        >
          <i class="i-tabler-x" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="listwise-lightbox__btn listwise-lightbox__nav listwise-lightbox__nav--left"
          :aria-label="$t('annotate.listwise.viewPrev')"
          :title="$t('annotate.listwise.viewPrev')"
          :aria-disabled="lightboxIndex <= 0"
          aria-keyshortcuts="ArrowLeft"
          @click="lightboxStep(-1)"
        >
          <i class="i-tabler-chevron-left" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="listwise-lightbox__btn listwise-lightbox__nav listwise-lightbox__nav--right"
          :aria-label="$t('annotate.listwise.viewNext')"
          :title="$t('annotate.listwise.viewNext')"
          :aria-disabled="lightboxIndex >= order.length - 1"
          aria-keyshortcuts="ArrowRight"
          @click="lightboxStep(1)"
        >
          <i class="i-tabler-chevron-right" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
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

.listwise-session:focus {
  outline: none;
}

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
.listwise-card:focus-visible {
  outline-offset: -2px;
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

.listwise-lightbox:focus {
  outline: none;
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
.listwise-lightbox__btn {
  position: absolute;
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
.listwise-lightbox__btn:hover {
  background: rgb(0 0 0 / 0.7);
}
.listwise-lightbox__btn[aria-disabled='true'] {
  opacity: 0.3;
  cursor: default;
}
.listwise-lightbox__nav {
  top: 50%;
  transform: translateY(-50%);
}
.listwise-lightbox__close {
  top: 18px;
  right: 18px;
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
