<script setup lang="ts">
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { provide, ref, useTemplateRef, watch, watchEffect } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useLayer } from '@/shared/layers'
import { isTypingTarget } from '@/utils/keyboard'
import { lastInputWasKeyboard, lastPointerPosition, trackInputModality } from './inputModality'
import { clampToViewport } from './overlay'

// Generic non-modal floating window (tag selector, folder context menu).
//
// - Opens at the cursor — or, when the last interaction was a key press, just
//   below the focused element — clamped inside the viewport (`safeMargin`).
// - Layer: Escape ALWAYS closes; an outside pointerdown closes unless pinned.
// - Focus: on open → [data-autofocus] → first focusable → the window; on close
//   it returns to where it was. Not a trap: Tab may leave (non-modal).
// - Drag: from an element marked `data-drag-handle` inside the slot; with no
//   handle, from anywhere except text fields. Uses pointer capture, and only
//   starts after a few pixels so plain clicks on buttons still work.
const props = withDefaults(defineProps<{
  safeMargin?: number
  pinned?: boolean
  /** @deprecated use v-model */
  show?: boolean
  role?: string
  ariaLabel?: string
  /**
   * Where focus goes on close when the element that opened the window is
   * gone (e.g. the opener was re-rendered by what the window changed).
   */
  returnFocus?: () => HTMLElement | null | undefined
}>(), {
  safeMargin: 4,
  role: 'dialog',
})

const DRAG_THRESHOLD = 3

trackInputModality()

const pinned = ref(props.pinned ?? false)
watchEffect(() => {
  pinned.value = props.pinned ?? false
})
provide('pinned', pinned)

const show = defineModel<boolean>({
  default: false,
})
const wrapper = useTemplateRef<HTMLElement>('wrapper')

/** Top-left corner, client px. */
const position = ref({ x: 0, y: 0 })
/** Where the window wants to be (cursor / focused element) until dragged. */
let anchor = { x: 0, y: 0 }
let dragged = false

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

function place() {
  const el = wrapper.value
  if (!el) {
    return
  }
  const { width, height } = el.getBoundingClientRect()
  position.value = clampToViewport(dragged ? position.value : anchor, { width, height }, viewport(), props.safeMargin)
}

// `sync`: read activeElement / pointer before anything mounts or moves focus.
watch(show, (on) => {
  if (!on) {
    return
  }
  const active = document.activeElement as HTMLElement | null
  if (lastInputWasKeyboard() && active && active !== document.body) {
    const r = active.getBoundingClientRect()
    anchor = { x: r.left, y: r.bottom + 4 }
  }
  else {
    anchor = lastPointerPosition()
  }
  dragged = false
  position.value = { ...anchor }
}, { flush: 'sync' })

watch(wrapper, (el) => {
  if (el) {
    place()
  }
}, { flush: 'post' })
useResizeObserver(wrapper, () => place())
useEventListener(globalThis, 'resize', () => place(), { passive: true })

function toggle() {
  show.value = !show.value
}

function close() {
  show.value = false
}

defineExpose({
  toggle,
})

useLayer(show, {
  el: () => wrapper.value,
  onEscape: () => close(),
  onPointerDownOutside: () => {
    if (!pinned.value) {
      close()
    }
  },
})

useFocusTrap(wrapper, show, { trapTab: false, returnFocus: () => props.returnFocus?.() })

// ---- drag -------------------------------------------------------------------
let pending: { pointerId: number, startX: number, startY: number, offsetX: number, offsetY: number } | null = null
const dragging = ref(false)

function onPointerDown(e: PointerEvent) {
  const el = wrapper.value
  if (e.button !== 0 || !el || !(e.target instanceof Element)) {
    return
  }
  const handles = el.querySelectorAll('[data-drag-handle]')
  if (handles.length > 0) {
    const handle = e.target.closest('[data-drag-handle]')
    if (!handle || !el.contains(handle)) {
      return
    }
  }
  else if (isTypingTarget(e.target)) {
    return
  }
  pending = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - position.value.x,
    offsetY: e.clientY - position.value.y,
  }
}

useEventListener(globalThis, 'pointermove', (e: PointerEvent) => {
  if (!pending || e.pointerId !== pending.pointerId) {
    return
  }
  if (!dragging.value) {
    if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < DRAG_THRESHOLD) {
      return
    }
    dragging.value = true
    try {
      wrapper.value?.setPointerCapture(pending.pointerId)
    }
    catch {
      // Pointer already released — the window listeners still track it.
    }
  }
  e.preventDefault()
  const el = wrapper.value
  if (!el) {
    return
  }
  const { width, height } = el.getBoundingClientRect()
  dragged = true
  position.value = clampToViewport(
    { x: e.clientX - pending.offsetX, y: e.clientY - pending.offsetY },
    { width, height },
    viewport(),
    props.safeMargin,
  )
})

function endDrag(e: PointerEvent) {
  if (!pending || e.pointerId !== pending.pointerId) {
    return
  }
  if (dragging.value && wrapper.value?.hasPointerCapture?.(e.pointerId)) {
    wrapper.value.releasePointerCapture(e.pointerId)
  }
  pending = null
  dragging.value = false
}
useEventListener(globalThis, 'pointerup', endDrag)
useEventListener(globalThis, 'pointercancel', endDrag)
</script>

<template>
  <transition
    name="popup"
    enter-active-class="transition ease-out duration-100"
    leave-active-class="transition ease-in duration-100"
    enter-from-class="transform opacity-0"
    enter-to-class="transform opacity-100"
    leave-from-class="transform scale-100 opacity-100"
    leave-to-class="transform scale-90 opacity-0"
  >
    <div
      v-if="show"
      ref="wrapper"
      class="p-float-window fixed"
      :class="{ 'p-float-window--dragging': dragging }"
      :role="role"
      :aria-label="ariaLabel"
      :style="{ left: `${position.x}px`, top: `${position.y}px`, zIndex: 'var(--p-z-float)' }"
      @pointerdown="onPointerDown"
    >
      <slot />
    </div>
  </transition>
</template>

<style>
.p-float-window:focus {
  outline: none;
}
.p-float-window [data-drag-handle] {
  cursor: move;
  touch-action: none;
}
.p-float-window--dragging {
  user-select: none;
}
</style>
