<script setup lang="ts">
import { useElementBounding, useElementSize, useMutationObserver, useScroll } from '@vueuse/core'
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    height?: number
    barWidth?: number
    threshold?: number
    stopPropagation?: boolean
    /** @deprecated No effect since the thumb drag uses pointer capture. */
    capture?: boolean
    minBarHeight?: number
    /**
     * Make the scroll viewport itself a Tab stop so arrow / Page / Home / End
     * scroll it — for text regions with no focusable content of their own.
     * Requires `ariaLabel` (a focusable region needs a name). Off by default:
     * a viewport full of controls is scrolled by focusing them.
     */
    focusable?: boolean
    ariaLabel?: string
  }>(),
  {
    barWidth: 4,
    threshold: 100,
    stopPropagation: false,
    capture: false,
    minBarHeight: 20,
  },
)
const scrollBarIndicatorRef = ref<HTMLElement>()
const scrollBarIndicatorBounds = useElementBounding(() => scrollBarIndicatorRef.value)

const scrollDomRef = ref<HTMLElement>()

// The scroll div has no padding and hides its native scrollbar, so the
// observed content-box height ≈ clientHeight.
const { height: clientHeight } = useElementSize(() => scrollDomRef.value)
const scrollHeight = ref(0)
// 为了检查滚动区域长度的变化，姑且使用 Mutation Observer
useMutationObserver(scrollDomRef, () => {
  if (scrollDomRef.value) {
    scrollHeight.value = scrollDomRef.value.scrollHeight
  }
}, {
  subtree: true,
  attributes: true,
  childList: true,
})
const scrollableLength = computed(() => {
  return (scrollHeight.value ?? 0) - (clientHeight.value ?? 0)
})

const { x, y } = useScroll(() => scrollDomRef.value)
const barProgress = computed(() => y.value / scrollableLength.value || 0)
const barHeight = computed(() => {
  if (!scrollDomRef.value) {
    return 0
  }
  const calculatedBarHeight = clientHeight.value / scrollHeight.value * clientHeight.value
  return Math.max(calculatedBarHeight, props.minBarHeight)
})
const scrollableHeight = computed(() => {
  return clientHeight.value - barHeight.value
})

const scrollBarData = computed(() => {
  if (!scrollDomRef.value) {
    return null
  }
  const barTop = barProgress.value * scrollableHeight.value
  return {
    x: x.value,
    y: y.value,
    barHeight: barHeight.value,
    barTop,
  }
})
const dragging = ref(false)
const dragStartY = ref(0)
const previousUserSelect = ref('')
const startScrollTop = ref(0)

// Thumb drag with pointer capture: moves keep arriving while the pointer is
// off the thumb (or outside the window) and the drag ends with exactly one
// pointerup / pointercancel / lostpointercapture — no document listeners.
function maybeStop(e: Event) {
  if (props.stopPropagation) {
    e.stopPropagation()
  }
}

function onThumbPointerDown(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  maybeStop(e)
  dragging.value = true
  dragStartY.value = e.clientY
  startScrollTop.value = y.value
  previousUserSelect.value = document.body.style.userSelect
  document.body.style.userSelect = 'none'
  scrollBarIndicatorRef.value?.setPointerCapture?.(e.pointerId)
}

function onThumbPointerMove(e: PointerEvent) {
  if (!dragging.value) {
    return
  }
  maybeStop(e)
  // Dragging far sideways off the bar snaps back to where the drag began
  // (native scrollbar behaviour on Windows).
  if ((props.threshold < scrollBarIndicatorBounds.left.value - e.clientX) || (e.clientX - scrollBarIndicatorBounds.right.value > props.threshold)) {
    y.value = startScrollTop.value
    return
  }
  const diff = e.clientY - dragStartY.value
  const progress = diff / scrollableHeight.value
  y.value = startScrollTop.value + progress * scrollableLength.value
}

function onThumbPointerEnd(e: PointerEvent) {
  if (!dragging.value) {
    return
  }
  maybeStop(e)
  dragging.value = false
  document.body.style.userSelect = previousUserSelect.value
  const thumb = scrollBarIndicatorRef.value
  if (thumb?.hasPointerCapture?.(e.pointerId)) {
    thumb.releasePointerCapture(e.pointerId)
  }
}

defineExpose({
  $el: scrollDomRef,
})
</script>

<template>
  <!-- isolation:isolate makes this root its own stacking context, so the
       scrollbar's z-index only competes with its sibling scroll content and
       never leaks into the surrounding layer stack (no --p-z-* step needed). -->
  <div
    class="relative overflow-hidden isolate"
  >
    <div
      v-if="scrollBarData"
      :style="{
        width: `${barWidth}px`,
      }"
      class="h-full right-0 absolute z-1"
    >
      <div
        v-show="scrollBarData.barHeight < clientHeight"
        ref="scrollBarIndicatorRef"
        aria-hidden="true"
        class="rounded-full bg-[var(--p-border-strong)] right-0 absolute touch-none"
        :style="{
          right: '0px',
          width: `${barWidth}px`,
          top: `${scrollBarData.barTop}px`,
          height: `${scrollBarData.barHeight}px`,
        }"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
        @pointerup="onThumbPointerEnd"
        @pointercancel="onThumbPointerEnd"
        @lostpointercapture="onThumbPointerEnd"
      />
    </div>
    <div
      ref="scrollDomRef"
      class="scroll-area h-full w-full overflow-auto"
      :tabindex="focusable ? 0 : undefined"
      :role="focusable ? 'region' : undefined"
      :aria-label="focusable ? ariaLabel : undefined"
      v-bind="$attrs"
      :style="{
        scrollbarWidth: 'none',
      }"
    >
      <slot />
    </div>
  </div>
</template>
