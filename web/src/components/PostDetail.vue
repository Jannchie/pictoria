<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { useElementBounding, useMouse } from '@vueuse/core'
import { computed, ref, watchEffect } from 'vue'
import { currentPostList, showPostDetail } from '@/shared'
import { getPostImageURL } from '@/utils'

const props = defineProps<{
  post: PostSimplePublic
}>()
const post = computed(() => props.post)
const imgSrc = computed(() => getPostImageURL(post.value))
const imgWrapperRef = ref<HTMLDivElement | null>(null)
const { width: imgWrapperWidth, height: imgWrapperHeight, left: imgWrapperLeft, top: imgWrapperTop } = useElementBounding(imgWrapperRef)
const imgContentWidth = computed(() => {
  return post.value.width!
})
const imgContentHeight = computed(() => {
  return post.value.height!
})
const imgWrapperRatio = computed(() => {
  return imgWrapperWidth.value / imgWrapperHeight.value
})
const imgContentRatio = computed(() => {
  return imgContentWidth.value / imgContentHeight.value
})

const initScale = computed(() => {
  if (imgWrapperRatio.value < imgContentRatio.value) {
    return imgWrapperWidth.value / imgContentWidth.value
  }
  return imgWrapperHeight.value / imgContentHeight.value
})
const scale = ref(initScale.value)

watchEffect(() => {
  scale.value = Math.round(initScale.value * 100) / 100
})
const scaleStr = computed(() => {
  return Number(scale.value * 100).toFixed(0)
})

const scaledInitWidth = computed(() => {
  return imgContentWidth.value * initScale.value
})

const scaledInitHeight = computed(() => {
  return imgContentHeight.value * initScale.value
})

const scaledWidth = computed(() => {
  return imgContentWidth.value * scale.value
})
const scaledHeight = computed(() => {
  return imgContentHeight.value * scale.value
})

const x = ref(0)
const y = ref(0)
watchEffect(() => {
  x.value = scaledInitWidth.value < imgWrapperWidth.value ? (imgWrapperWidth.value - scaledInitWidth.value) / 2 : 0
  y.value = scaledInitHeight.value < imgWrapperHeight.value ? (imgWrapperHeight.value - scaledInitHeight.value) / 2 : 0
})

const mouse = useMouse({ type: 'client' })
const mx = computed(() => mouse.x.value - imgWrapperLeft.value)
const my = computed(() => mouse.y.value - imgWrapperTop.value)
function toInit() {
  scale.value = initScale.value
  x.value = (imgWrapperWidth.value - scaledWidth.value) / 2
  y.value = (imgWrapperHeight.value - scaledHeight.value) / 2
}
function to1x() {
  scale.value = 1
  x.value = (imgWrapperWidth.value - scaledWidth.value) / 2
  y.value = (imgWrapperHeight.value - scaledHeight.value) / 2
}
function onWheel(e: WheelEvent) {
  e.preventDefault()

  // 计算缩放前鼠标相对于图片的位置
  const offsetX = (mx.value - x.value) / scale.value
  const offsetY = (my.value - y.value) / scale.value

  // 更新缩放比例
  const delta = e.deltaY
  const newScale = Math.max(0.1, Math.min(8, scale.value * (1 - delta / 1000)))
  scale.value = Math.round(newScale * 100) / 100

  // 计算缩放后图片左上角的位置
  x.value = mx.value - offsetX * newScale
  y.value = my.value - offsetY * newScale
}
const movingCanvas = ref(false)

function onPointerDown(e: PointerEvent) {
  if (e.buttons === 1) {
    e.preventDefault()
    movingCanvas.value = true
  }
}

function onPointermove(e: PointerEvent) {
  if (e.buttons === 1 && movingCanvas.value) {
    x.value = x.value + e.movementX
    y.value = y.value + e.movementY
  }
}

function onPointerUp() {
  movingCanvas.value = false
}

const miniMapScale = computed(() => {
  // 缩略图比例要基于容器的宽高
  const maxWidth = 150 // 比如缩略图最大宽度为150px
  const maxHeight = 150 // 比如缩略图最大高度为150px
  const widthRatio = maxWidth / imgContentWidth.value
  const heightRatio = maxHeight / imgContentHeight.value
  return Math.min(widthRatio, heightRatio)
})

const miniMapWidth = computed(() => imgContentWidth.value * miniMapScale.value)
const miniMapHeight = computed(() => imgContentHeight.value * miniMapScale.value)

const miniMapViewBox = computed(() => ({
  width: imgWrapperWidth.value * miniMapScale.value / scale.value,
  height: imgWrapperHeight.value * miniMapScale.value / scale.value,
  x: -x.value * miniMapScale.value / scale.value,
  y: -y.value * miniMapScale.value / scale.value,
}))

const dragging = ref(false)
const startMiniMapViewBox = { x: 0, y: 0 }

const miniMapRef = ref<HTMLDivElement | null>(null)

const miniMapBounding = useElementBounding(miniMapRef)

function onMiniMapPointerDown(e: PointerEvent) {
  dragging.value = true
  startMiniMapViewBox.x = -x.value * miniMapScale.value / scale.value
  startMiniMapViewBox.y = -y.value * miniMapScale.value / scale.value

  const clickX = e.clientX - miniMapBounding.left.value
  const clickY = e.clientY - miniMapBounding.top.value

  const offsetX = (clickX / miniMapScale.value) - (imgWrapperWidth.value / (2 * scale.value))
  const offsetY = (clickY / miniMapScale.value) - (imgWrapperHeight.value / (2 * scale.value))

  x.value = -offsetX * scale.value
  y.value = -offsetY * scale.value
}

function onMiniMapPointerMove(e: PointerEvent) {
  if (dragging.value) {
    const offsetX = e.movementX / miniMapScale.value
    const offsetY = e.movementY / miniMapScale.value

    x.value -= offsetX * scale.value
    y.value -= offsetY * scale.value
  }
}

function onMiniMapPointerUp() {
  dragging.value = false
}

function adjustForScaling(newScale: number, mouseX: number, mouseY: number) {
  // 计算当前鼠标相对于图片的位置
  const currentMouseOffsetX = (mouseX - x.value) / scale.value
  const currentMouseOffsetY = (mouseY - y.value) / scale.value

  // 计算新缩放比例下鼠标相对于图片的位置
  const newMouseOffsetX = currentMouseOffsetX * newScale
  const newMouseOffsetY = currentMouseOffsetY * newScale

  // 调整图片位置，使得图像的中心保持不变
  x.value = mouseX - newMouseOffsetX
  y.value = mouseY - newMouseOffsetY
}

function scaleWithSlider(newScale: number) {
  const mouseX = imgWrapperWidth.value / 2
  const mouseY = imgWrapperHeight.value / 2
  adjustForScaling(newScale, mouseX, mouseY)
  scale.value = newScale
}
const filpVertical = ref(false)
function toggleFlipVertical() {
  filpVertical.value = !filpVertical.value
}

onKeyStroke('Escape', () => {
  showPostDetail.value = null
})

function navigateDetail(delta: -1 | 1) {
  const list = currentPostList.value
  if (list.length === 0) {
    return
  }
  const idx = list.findIndex(p => p.id === post.value.id)
  if (idx === -1) {
    return
  }
  const nextIdx = Math.max(0, Math.min(list.length - 1, idx + delta))
  if (nextIdx === idx) {
    return
  }
  showPostDetail.value = list[nextIdx]
}

function zoomBy(factor: number) {
  const mouseX = imgWrapperWidth.value / 2
  const mouseY = imgWrapperHeight.value / 2
  const newScale = Math.max(0.1, Math.min(8, scale.value * factor))
  const rounded = Math.round(newScale * 100) / 100
  adjustForScaling(rounded, mouseX, mouseY)
  scale.value = rounded
}

const activeElementInDetail = useActiveElement()
const notUsingInputDetail = computed(() =>
  activeElementInDetail.value?.tagName !== 'INPUT'
  && activeElementInDetail.value?.tagName !== 'TEXTAREA')

onKeyStroke(['ArrowLeft', 'ArrowRight'], (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  navigateDetail(e.key === 'ArrowRight' ? 1 : -1)
})

onKeyStroke(['+', '='], (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  zoomBy(1.1)
})

onKeyStroke('-', (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  zoomBy(1 / 1.1)
})

onKeyStroke('0', (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  toInit()
})

onKeyStroke('\\', (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  to1x()
})

onKeyStroke(['f', 'F'], (e) => {
  if (!notUsingInputDetail.value) {
    return
  }
  e.preventDefault()
  toggleFlipVertical()
})
</script>

<template>
  <div
    class="bg-bg flex flex-col inset-0 absolute z-10000"
  >
    <header class="px-2 py-2 border-b border-border-default flex gap-2 items-center justify-between">
      <div class="flex flex-1 basis-0 gap-2 items-center overflow-hidden">
        <Popover
          position="bottom"
          trigger="hover"
        >
          <PButton
            icon
            size="sm"
            variant="ghost"
            @click="showPostDetail = null"
          >
            <i class="i-tabler-arrow-left" />
          </PButton>
          <template #content>
            <PSurface
              level="1"
              bordered
              class="text-xs px-2 py-1 text-center"
            >
              <kbd>Esc</kbd>
              <span class="text-fg-muted ml-1">to close</span>
            </PSurface>
          </template>
        </Popover>
        <span class="text-sm text-fg-muted truncate">
          {{ `${post.fileName}.${post.extension}` }}
        </span>
      </div>
      <div class="flex gap-2 items-center justify-center">
        <div class="text-xs text-fg-muted font-mono w-32px tabular-nums">
          {{ scaleStr }}%
        </div>
        <Slider
          :model-value="scale"
          size="sm"
          :min="0.10"
          :max="8.00"
          :step="0.01"
          :min-width="8"
          @update:model-value="scaleWithSlider"
        />
        <Popover
          position="bottom"
          trigger="hover"
        >
          <PButton
            icon
            size="sm"
            @click="toInit"
          >
            <i class="i-tabler-focus-centered" />
          </PButton>
          <template #content>
            <PSurface
              level="1"
              bordered
              class="text-xs px-2 py-1 text-center"
            >
              initial scale
            </PSurface>
          </template>
        </Popover>
        <PButton
          icon
          size="sm"
          @click="to1x"
        >
          <i class="i-tabler-multiplier-1x" />
        </PButton>
        <PButton
          icon
          size="sm"
          @click="toggleFlipVertical"
        >
          <i class="i-tabler-flip-vertical" />
        </PButton>
      </div>
      <div class="flex-1 basis-0" />
    </header>
    <div
      ref="imgWrapperRef"
      class="flex-grow h-full w-full relative overflow-hidden"
      @pointerdown.stop="onPointerDown"
      @pointermove.stop="onPointermove"
      @pointerup.stop="onPointerUp"
      @wheel.stop="onWheel"
    >
      <img
        class="absolute object-contain"
        :draggable="false"
        :style="{
          minWidth: `${imgContentWidth * scale}px`,
          minHeight: `${imgContentHeight * scale}px`,
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
          left: `${x}px`,
          top: `${y}px`,
          transform: `scaleX(${filpVertical ? -1 : 1})`,
        }"
        :src="imgSrc"
      >
      <div
        ref="miniMapRef"
        class="border border-border-strong rounded bg-bg shadow-lg bottom-4 left-4 absolute z-200 overflow-hidden"
        @pointerdown.stop="onMiniMapPointerDown"
        @pointerup.stop="onMiniMapPointerUp"
        @pointermove.stop="onMiniMapPointerMove"
        @mouseleave.stop="onMiniMapPointerUp"
      >
        <div
          class="relative"
          :style="{
            width: `${miniMapWidth}px`,
            height: `${miniMapHeight}px`,
            overflow: 'hidden',
          }"
        >
          <img
            :draggable="false"
            class="absolute object-contain"
            :src="imgSrc"
            :style="{
              width: `${miniMapWidth}px`,
              height: `${miniMapHeight}px`,
            }"
          >
          <!-- 显示视口框 -->
          <div
            class="border-2 border-primary absolute"
            :style="{
              width: `${miniMapViewBox.width}px`,
              height: `${miniMapViewBox.height}px`,
              left: `${miniMapViewBox.x}px`,
              top: `${miniMapViewBox.y}px`,
            }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
