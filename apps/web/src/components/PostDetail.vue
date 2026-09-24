<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { useElementBounding, useMouse } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, useId, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useAdjacentImagePreload } from '@/composables/useAdjacentImagePreload'
import { useEdgeProximity } from '@/composables/useEdgeProximity'
import { useFocusReturn } from '@/composables/useFocusTrap'
import { useHotkey } from '@/composables/useHotkey'
import { useKeyScope } from '@/composables/useKeyScope'
import { usePostNavAnnounce, usePostNavigation } from '@/composables/usePostNavigation'
import { isAnyDialogOpen, lastViewedPostId, showPostDetail, useLayer } from '@/shared'
import { getPostImageURL, getPostThumbnailURL } from '@/utils'
import { focusElement } from '@/utils/focus'
import { isValueWidgetTarget } from '@/utils/keyboard'
import { allowsViewKeys, clampScale, PAN_SHORTCUTS, panOffset } from '@/utils/postViewerKeys'

const props = defineProps<{
  post: PostSimplePublic
  /**
   * 关闭时焦点的兜底去处 —— 打开前焦点在 `<body>`（例如键盘在空白处按 Enter）
   * 或原元素已不在文档里时用它。详情页传主图。
   */
  returnFocus?: () => HTMLElement | null | undefined
}>()

const router = useRouter()

const post = computed(() => props.post)
const imgSrc = computed(() => getPostImageURL(post.value))
const thumbSrc = computed(() => getPostThumbnailURL(post.value))

// 原图是否已到。没到之前用缩略图占位（网格浏览过，几乎必中浏览器缓存），
// 左右切换不再出现空白等待；原图 onload 后无缝盖上。
const mainLoaded = ref(false)
watch(imgSrc, () => {
  mainLoaded.value = false
})

// 预载相邻原图（和 views/Post.vue 同一个 composable）。这个覆盖层是列表里
// ←→ 浏览的主路径，此前只有 /post/:id 独立页有预载 —— 在这里切图每张都是
// 冷加载，大图要等一拍。
useAdjacentImagePreload(() => post.value.id)
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
  const newScale = clampScale(scale.value * (1 - delta / 1000))
  scale.value = newScale

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
const flipHorizontal = ref(false)
function toggleFlipHorizontal() {
  flipHorizontal.value = !flipHorizontal.value
}

/**
 * 关闭查看器。记下正在看的这张，回到画廊时网格据此恢复选中和焦点
 * （见 `lastViewedPostId`）。
 */
function close() {
  lastViewedPostId.value = post.value.id
  showPostDetail.value = null
}

// 指针贴近画布左右边缘时才浮出翻页按钮。
const nearEdge = useEdgeProximity(imgWrapperRef)

const { index, total, canPrev, canNext, neighbor } = usePostNavigation(() => post.value.id)
const announceNav = usePostNavAnnounce()

function navigateDetail(delta: -1 | 1) {
  const next = neighbor(delta)
  if (!next) {
    return
  }
  const position = index.value + delta + 1
  showPostDetail.value = next
  // Keep the underlying detail route in sync so the right-panel sidebar,
  // selection and the page behind the overlay all follow the viewed image
  // (mirrors Post.vue's navigatePost).
  if (next?.id !== undefined) {
    router.replace(`/post/${next.id}`)
  }
  announceNav(next, position, total.value)
  // 翻到头时对应那侧的竖条会被 v-if 拿掉；焦点若正停在它上面会掉回 <body>，
  // 这里把它接回画布。
  nextTick(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      focusElement(imgWrapperRef.value, { preventScroll: true })
    }
  })
}

function zoomBy(factor: number) {
  const mouseX = imgWrapperWidth.value / 2
  const mouseY = imgWrapperHeight.value / 2
  const rounded = clampScale(scale.value * factor)
  adjustForScaling(rounded, mouseX, mouseY)
  scale.value = rounded
}

function panBy(key: string) {
  const offset = panOffset(key, imgWrapperWidth.value, imgWrapperHeight.value)
  if (offset) {
    x.value += offset.dx
    y.value += offset.dy
  }
}

const dialogRef = ref<HTMLElement | null>(null)

// 非模态：覆盖层只盖住中间栏，右侧面板照常可用（打分、改标签），所以不设
// aria-modal、不锁 Tab、不 inert 页面其余部分；它仍是图层栈上的一层 ——
// Escape 只关它（上面若还有弹层，先关弹层），点外面（右侧面板）不关。
useLayer(true, {
  el: () => dialogRef.value,
  onEscape: close,
})
// 关闭时把焦点还给打开它的元素（缩略图 / 主图），不在了就用调用方给的兜底。
useFocusReturn(true, {
  container: () => dialogRef.value,
  returnFocus: () => props.returnFocus?.(),
})
onMounted(() => {
  // 焦点落在画布上：它不是控件，所有查看器热键在这里都生效，读屏读出图名。
  focusElement(imgWrapperRef.value, { preventScroll: true })
})

// While the overlay is mounted (showPostDetail is set), 'detailOverlay' is the
// active scope exactly when focus isn't in a text field. A modal dialog above
// (e.g. a delete confirm) also stands the viewer's keys down.
const activeKeyScope = useKeyScope()
const canHandleKeys = () => activeKeyScope.value === 'detailOverlay' && !isAnyDialogOpen.value

// ←→ / Shift+方向键：焦点在控件上时让位（缩放滑块的方向键只调缩放），但本
// 查看器自己的普通按钮（翻页竖条、工具栏按钮）放行 —— 点完「下一张」再按 →
// 应该继续翻。见 `allowsViewKeys`。
const viewKeyOptions = {
  when: canHandleKeys,
  allowInWidgets: true,
  ignore: (e: KeyboardEvent) => !allowsViewKeys(e.target, dialogRef.value),
}
// 字符键（缩放 / 翻转）没有控件会用，只避开数值控件（数字键属于它们）。
const charKeyOptions = {
  when: canHandleKeys,
  allowInWidgets: true,
  ignore: (e: KeyboardEvent) => isValueWidgetTarget(e.target),
}

useHotkey(['ArrowLeft', 'ArrowRight'], (e) => {
  navigateDetail(e.key === 'ArrowRight' ? 1 : -1)
}, viewKeyOptions)
useHotkey(PAN_SHORTCUTS, e => panBy(e.key), viewKeyOptions)
useHotkey(['+', '='], () => zoomBy(1.1), charKeyOptions)
useHotkey('-', () => zoomBy(1 / 1.1), charKeyOptions)
useHotkey('0', toInit, charKeyOptions)
useHotkey('\\', to1x, charKeyOptions)
useHotkey(['f', 'Shift+F'], toggleFlipHorizontal, { ...charKeyOptions, repeat: false })

const hintId = useId()
const fileLabel = computed(() => `${post.value.fileName}.${post.value.extension}`)
</script>

<template>
  <!-- 非模态对话框：只盖住中间栏，Tab 可以离开它去右侧面板（见 script 里的 useLayer）。 -->
  <div
    ref="dialogRef"
    role="dialog"
    :aria-label="$t('post.viewerAria', { name: fileLabel })"
    tabindex="-1"
    class="bg-bg flex flex-col inset-0 absolute z-[var(--p-z-popup)] focus:outline-none"
    style="overscroll-behavior: contain;"
  >
    <header class="px-2 py-2 border-b border-border-default flex gap-2 items-center justify-between">
      <div class="flex flex-1 basis-0 gap-2 items-center overflow-hidden">
        <PPopover
          position="bottom"
          trigger="hover"
        >
          <PButton
            icon
            size="sm"
            variant="ghost"
            :aria-label="$t('post.closeViewer')"
            aria-keyshortcuts="Escape"
            @click="close"
          >
            <i class="i-tabler-arrow-left" aria-hidden="true" />
          </PButton>
          <template #content>
            <PSurface
              level="1"
              bordered
              class="text-xs px-2 py-1 text-center"
            >
              <kbd>Esc</kbd>
              <span class="text-fg-muted ml-1">{{ $t('post.escToClose') }}</span>
            </PSurface>
          </template>
        </PPopover>
        <span class="text-sm text-fg-muted truncate">
          {{ fileLabel }}
        </span>
      </div>
      <div class="flex gap-2 items-center justify-center">
        <div class="text-xs text-fg-muted font-mono w-32px tabular-nums" aria-hidden="true">
          {{ scaleStr }}%
        </div>
        <PSlider
          :model-value="scale"
          size="sm"
          :min="0.10"
          :max="8.00"
          :step="0.01"
          :min-width="8"
          :aria-label="$t('post.zoom')"
          :aria-valuetext="`${scaleStr}%`"
          @update:model-value="scaleWithSlider"
        />
        <PPopover
          position="bottom"
          trigger="hover"
        >
          <PButton
            icon
            size="sm"
            :aria-label="$t('post.fitToViewport')"
            aria-keyshortcuts="0"
            @click="toInit"
          >
            <i class="i-tabler-focus-centered" aria-hidden="true" />
          </PButton>
          <template #content>
            <PSurface
              level="1"
              bordered
              class="text-xs px-2 py-1 text-center"
            >
              {{ $t('post.initialScale') }}
            </PSurface>
          </template>
        </PPopover>
        <PButton
          icon
          size="sm"
          :aria-label="$t('post.actualSize')"
          aria-keyshortcuts="\"
          @click="to1x"
        >
          <i class="i-tabler-multiplier-1x" aria-hidden="true" />
        </PButton>
        <PButton
          icon
          size="sm"
          :aria-label="$t('post.flipHorizontal')"
          :aria-pressed="flipHorizontal"
          aria-keyshortcuts="F"
          @click="toggleFlipHorizontal"
        >
          <i class="i-tabler-flip-vertical" aria-hidden="true" />
        </PButton>
      </div>
      <div class="flex-1 basis-0" />
    </header>
    <!-- 画布本身可聚焦（打开时焦点落在这里）：role=img 让读屏读出图名和缩放，
         操作说明挂在 aria-describedby 上。 -->
    <div
      ref="imgWrapperRef"
      tabindex="0"
      role="img"
      :aria-label="$t('post.viewerCanvas', { name: fileLabel, zoom: scaleStr })"
      :aria-describedby="hintId"
      class="viewer-canvas flex-grow h-full w-full relative overflow-hidden"
      style="touch-action: none;"
      @pointerdown.stop="onPointerDown"
      @pointermove.stop="onPointermove"
      @pointerup.stop="onPointerUp"
      @wheel.stop="onWheel"
    >
      <!-- 缩略图占位：与原图同几何叠放在下层，原图 onload 前顶着画面。 -->
      <img
        v-if="!mainLoaded"
        class="absolute object-contain"
        alt=""
        aria-hidden="true"
        :draggable="false"
        :width="imgContentWidth"
        :height="imgContentHeight"
        :style="{
          minWidth: `${imgContentWidth * scale}px`,
          minHeight: `${imgContentHeight * scale}px`,
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
          left: `${x}px`,
          top: `${y}px`,
          transform: `scaleX(${flipHorizontal ? -1 : 1})`,
        }"
        :src="thumbSrc"
      >
      <img
        class="absolute object-contain"
        :class="{ 'opacity-0': !mainLoaded }"
        :alt="fileLabel"
        :draggable="false"
        :width="imgContentWidth"
        :height="imgContentHeight"
        :style="{
          minWidth: `${imgContentWidth * scale}px`,
          minHeight: `${imgContentHeight * scale}px`,
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
          left: `${x}px`,
          top: `${y}px`,
          transform: `scaleX(${flipHorizontal ? -1 : 1})`,
        }"
        :src="imgSrc"
        @load="mainLoaded = true"
      >
      <!-- 左右翻页。平时透明,指针贴近那一侧才浮出来。竖条只占自身面积,拖拽 /
           缩放照旧作用于画布(它自己 stop 掉 pointerdown,否则按下会先被画布当成
           一次拖拽起点)。 -->
      <PEdgeNavRail
        v-if="canPrev"
        side="left"
        :shown="nearEdge === 'left'"
        :label="$t('post.previous')"
        aria-keyshortcuts="ArrowLeft"
        @click.stop="navigateDetail(-1)"
      />
      <PEdgeNavRail
        v-if="canNext"
        side="right"
        :shown="nearEdge === 'right'"
        :label="$t('post.next')"
        aria-keyshortcuts="ArrowRight"
        @click.stop="navigateDetail(1)"
      />
      <!-- 小地图只是指针的快捷平移（键盘用 Shift+方向键），对读屏是装饰。 -->
      <div
        ref="miniMapRef"
        aria-hidden="true"
        class="border border-border-strong rounded bg-bg shadow-md bottom-4 left-4 absolute z-1 overflow-hidden"
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
            alt=""
            aria-hidden="true"
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
    <p :id="hintId" class="sr-only">
      {{ $t('post.viewerHint') }}
    </p>
  </div>
</template>

<style scoped>
/* 画布贴满容器且 overflow:hidden，焦点环收进内侧才看得见。 */
.viewer-canvas:focus-visible {
  outline-offset: -2px;
}
</style>
