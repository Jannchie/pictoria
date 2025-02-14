<script setup lang="ts">
import { onClickOutside, useElementBounding, useMouse, useWindowSize } from '@vueuse/core'
import { nextTick, provide, ref, watch, watchEffect } from 'vue'

const props = withDefaults(defineProps<{
  safeMargin?: number
  pinned?: boolean
  show?: boolean
}>(), {
  safeMargin: 4,
})

const pinned = ref(props.pinned ?? false)
watchEffect(() => {
  pinned.value = props.pinned ?? false
})
provide('pinned', pinned)
const show = defineModel({
  default: false,
})
const position = ref({ left: '0px', top: '0px' })
const mouse = useMouse()
const { width: windowWidth, height: windowHeight } = useWindowSize()
const wrapper = ref<HTMLElement | null>(null)
const bounding = useElementBounding(wrapper)

watch(() => {
  return bounding.width.value
}, () => {
  nextTick(() => {
    if (wrapper.value) {
      let newLeft = mouse.x.value
      let newTop = mouse.y.value
      const safeMargin = props.safeMargin
      // Adjust left position considering safeMargin
      if (newLeft + bounding.width.value > windowWidth.value - safeMargin) {
        newLeft = windowWidth.value - bounding.width.value - safeMargin
      }
      // Adjust top position considering safeMargin
      if (newTop + bounding.height.value > windowHeight.value - safeMargin) {
        newTop = windowHeight.value - bounding.width.value - safeMargin
      }

      position.value = {
        left: `${newLeft}px`,
        top: `${newTop}px`,
      }
    }
  })
})

function toggle() {
  show.value = !show.value
}

defineExpose({
  toggle,
})

onClickOutside(wrapper, () => {
  if (pinned.value) {
    return
  }
  show.value = false
})

const dragging = ref(false)
const offset = ref({ x: 0, y: 0 })
function startDrag(e: { button: number, pageX: number, pageY: number }) {
  if (e.button !== 0) {
    return
  }
  dragging.value = true
  offset.value = {
    x: e.pageX - bounding.left.value,
    y: e.pageY - bounding.top.value,
  }
}

function drag(e: { pageX: number, pageY: number }) {
  if (dragging.value === false) {
    return
  }
  const newLeft = e.pageX - offset.value.x
  const newTop = e.pageY - offset.value.y
  position.value = {
    left: `${newLeft}px`,
    top: `${newTop}px`,
  }
}

function stopDrag() {
  dragging.value = false
}
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
      class="fixed"
      :style="[position, { zIndex: 1000000 }]"
      @pointerdown="startDrag"
      @pointermove="drag"
      @pointerup="stopDrag"
    >
      <slot />
    </div>
  </transition>
</template>
