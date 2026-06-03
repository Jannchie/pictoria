<script setup lang="ts">
import { useElementBounding, useEventListener, useMouse } from '@vueuse/core'
import { computed, ref } from 'vue'

const props = defineProps<{
  target?: HTMLElement | null
}>()
const emit = defineEmits<{
  selectStart: [{ target: EventTarget | null, shift: boolean, ctrl: boolean }]
  selectChange: [Area, { target: EventTarget | null, shift: boolean, ctrl: boolean }]
  selectEnd: [Area, { target: EventTarget | null, shift: boolean, ctrl: boolean }]
}>()
const { shift, control: ctrl } = useMagicKeys()
export interface Area {
  left: number
  top: number
  right: number
  bottom: number
}

const target = computed(() => props.target ?? document.documentElement)
const mouse = useMouse()
const startPoint = ref({ x: 0, y: 0 })
const endPoint = ref({ x: 0, y: 0 })
// pointerDown：左键已在 target 内按下；dragging：已移动超过阈值、真正进入框选。
// 把两者分开是关键：纯点击（pointerDown 但从未越过阈值）绝不渲染选框层、也不在
// 松手时 emit selectEnd。否则每一次点击都被当成一次框选——选框层(z-10000)会盖在
// 删除确认按钮(POverlay z-40)上方，pointerup 落到选框层而非按钮，click 不成立，
// 于是“选框更优先，点不下按钮”；同时 selectEnd 还会无谓地重写 selectedPostIdSet。
const pointerDown = ref(false)
const dragging = ref(false)
// 指针按下后要移动超过这么多像素才算拖拽框选，否则视为普通点击。
const DRAG_THRESHOLD = 5
const targetBounds = useElementBounding(target)
const targetScroll = useScroll(target)

function relativePoint(pageX: number, pageY: number) {
  return {
    x: pageX - targetBounds.left.value + targetScroll.x.value,
    y: pageY - targetBounds.top.value + targetScroll.y.value,
  }
}

function currentArea(): Area {
  return {
    left: Math.min(startPoint.value.x, endPoint.value.x),
    top: Math.min(startPoint.value.y, endPoint.value.y),
    right: Math.max(startPoint.value.x, endPoint.value.x),
    bottom: Math.max(startPoint.value.y, endPoint.value.y),
  }
}

useEventListener(target, 'pointerdown', (e) => {
  // if not left click, return
  if (e.button !== 0) {
    return
  }
  const p = relativePoint(e.pageX, e.pageY)
  startPoint.value = p
  endPoint.value = p
  pointerDown.value = true
  // 先不进入 dragging——等移动超过阈值再说，让纯点击保持纯点击。
  dragging.value = false
})

// 捕获任意元素的 pointerup
useEventListener(globalThis, 'pointerup', (e) => {
  const wasDragging = dragging.value
  pointerDown.value = false
  dragging.value = false
  // 只有真正拖拽过才提交框选；纯点击不动 selectedPostIdSet。
  if (wasDragging) {
    emit('selectEnd', currentArea(), { target: e.target, shift: shift.value, ctrl: ctrl.value })
  }
})

useEventListener(target, 'pointermove', (e) => {
  if (!pointerDown.value) {
    return
  }
  endPoint.value = relativePoint(e.pageX, e.pageY)
  if (!dragging.value) {
    // 还没越过拖拽阈值——仍按普通点击对待，不渲染选框、不发选择事件。
    if (
      Math.abs(endPoint.value.x - startPoint.value.x) < DRAG_THRESHOLD
      && Math.abs(endPoint.value.y - startPoint.value.y) < DRAG_THRESHOLD
    ) {
      return
    }
    dragging.value = true
    emit('selectStart', { target: e.target, shift: shift.value, ctrl: ctrl.value })
  }
  emit('selectChange', currentArea(), { target: e.target, shift: shift.value, ctrl: ctrl.value })
})
const parent = computed(() => {
  if (!target.value) {
    return null
  }
  return target.value.parentElement
})
useEventListener(parent, 'scroll', (e) => {
  if (!dragging.value) {
    return
  }
  endPoint.value = relativePoint(mouse.x.value, mouse.y.value)
  emit('selectChange', currentArea(), { target: e.target, shift: shift.value, ctrl: ctrl.value })
})

useEventListener(globalThis, 'dragend', () => {
  pointerDown.value = false
  dragging.value = false
})
</script>

<template>
  <div class="relative">
    <div
      v-if="dragging"
      class="border border-primary/75 bg-primary/25 h-1 absolute z-10000"
      :style="{
        left: `${Math.min(startPoint.x, endPoint.x)}px`,
        top: `${Math.min(startPoint.y, endPoint.y)}px`,
        width: `${Math.abs(startPoint.x - endPoint.x)}px`,
        height: `${Math.abs(startPoint.y - endPoint.y)}px`,
      }"
    />
  </div>
</template>
