import type { MaybeElementRef } from '@vueuse/core'
import { useMouseInElement } from '@vueuse/core'
import { computed } from 'vue'

/** 边缘感应带：取元素宽度的这个比例，但不超过 `EDGE_MAX_PX`。 */
const EDGE_RATIO = 0.22
const EDGE_MAX_PX = 180

/**
 * 指针是否贴近某个元素的左 / 右边缘。
 *
 * 给「上一张 / 下一张」这类平时该隐身的悬浮控件用：靠近了才淡入，不靠近就完全
 * 不打扰画面。
 *
 * 为什么算距离而不是给按钮套一个 `:hover` 热区：热区要能被 `:hover` 命中就必须
 * 吃掉指针事件，那块面积上的点击、框选、拖拽平移就全废了 —— 而这两处的边缘带
 * 恰好压在图片上。`useMouseInElement` 只被动读坐标，什么都不拦，而且元素矩形走
 * ResizeObserver 缓存，不必每次指针移动都 `getBoundingClientRect()` 触发回流。
 */
export function useEdgeProximity(target: MaybeElementRef) {
  const { elementX, elementWidth, isOutside } = useMouseInElement(target)

  return computed<'left' | 'right' | null>(() => {
    if (isOutside.value) {
      return null
    }
    const threshold = Math.min(EDGE_MAX_PX, elementWidth.value * EDGE_RATIO)
    if (elementX.value <= threshold) {
      return 'left'
    }
    return elementX.value >= elementWidth.value - threshold ? 'right' : null
  })
}
