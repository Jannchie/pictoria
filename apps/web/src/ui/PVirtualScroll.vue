<script setup lang="ts" generic="T">
import type { Component } from 'vue'
import { controlledComputed, debouncedWatch, useElementBounding, useScroll } from '@vueuse/core'
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  is?: Component | string
  items?: T[]
  /**
   * 已知行高时传它（按项给，分组标题行和内容行可以不同高），虚拟滚动就走定高
   * 快路径：不再逐帧量 DOM，高度表只在 `items` 变化时算一次。项数上万时这是
   * 唯一还能用的路径 —— 量 DOM 的那条每滚一次都要 `querySelectorAll` + 读
   * `clientHeight`（强制回流）。
   *
   * ⚠️ 别改用 `@vueuse/core` 的 `useVirtualList`（PTreeList 用的那个）来省掉这
   * 个组件：它对函数式 itemHeight 的偏移量是
   * `source.slice(0, index).reduce(...)` —— 每滚一次都 O(n)。侧栏那几百项无所
   * 谓，这里的近万行实测会让 long task 从 ~60ms 涨到 ~140ms。下面的前缀和 +
   * 二分是 O(log n)。
   */
  itemHeight?: (item: T, index: number) => number
  /** 视口上下各多渲染几项，缓掉快速滚动时的白边。 */
  overscan?: number
}>(), {
  items: () => [],
  is: 'div',
  overscan: 3,
})
const slotReferences = ref<HTMLDivElement[]>([])

const wrapper = ref<any>(undefined)
const wrapperBounds = useElementBounding(wrapper)
const wrapperHeight = computed(() => wrapperBounds.height.value)

const scroll = useScroll(wrapper)
const scrollY = computed(() => scroll.y.value)
// watchEffect(() => {
//   console.log(scrollY.value)
// })
const calculatedHeightsTrue = ref<number[]>([])
const avgHeight = controlledComputed(() => {
  return [calculatedHeightsTrue.value]
}, () => {
  const heights = calculatedHeightsTrue.value
  if (heights.length === 0) {
    return 20
  }

  // 过滤掉 falsy 值
  let sum = 0
  let count = 0

  for (const height of heights) {
    if (height) {
      sum += height
      count++
    }
  }
  return count === 0 ? 20 : sum / count
})

const calculatedHeights = computed<number[]>(() => {
  const fixed = props.itemHeight
  if (fixed) {
    return props.items.map((item, index) => fixed(item, index))
  }
  return props.items.map((_, index) => {
    if (calculatedHeightsTrue.value[index]) {
      return calculatedHeightsTrue.value[index]
    }
    return avgHeight.value
  })
})

/**
 * 独占前缀和，长度是 `items.length + 1`：`accumulated[i]` 是前 i 项的高度和，
 * 末元素就是总高。多留这一格，`paddingTop` / `remainHeight` / 总高就都是直接
 * 取下标，不必再为「最后一项」写 `at(-1)` 和空值兜底。
 */
const accumulatedHeights = controlledComputed(() => {
  return [calculatedHeights.value]
}, () => {
  const heights = calculatedHeights.value
  const accumulated = Array.from({ length: heights.length + 1 }) as number[]
  accumulated[0] = 0
  for (const [index, height] of heights.entries()) {
    accumulated[index + 1] = accumulated[index] + height
  }
  return accumulated
})

function binarySearch(array: number[], target: number) {
  let start = 0
  let end = array.length - 1
  if (target <= array[0]) {
    return 0
  }

  while (start <= end) {
    const mid = Math.floor((start + end) / 2)
    if (array[mid] < target && array[mid + 1] >= target) {
      return mid + 1
    }
    else if (array[mid] < target) {
      start = mid + 1
    }
    else {
      end = mid - 1
    }
  }

  return -1
}

function clampIndex(index: number) {
  return Math.max(0, Math.min(props.items.length, index))
}

// 两端都直接夹到 [0, items.length]，不再让二分的「没找到」哨兵漏到下游 ——
// 列表变短而 scrollY 还停在旧位置时（搜索把结果筛没了），哨兵会让整屏空白。
const startIdx = controlledComputed(() => {
  return [scrollY.value, accumulatedHeights.value, props.overscan]
}, () => {
  const index = binarySearch(accumulatedHeights.value, scrollY.value) - 1
  return clampIndex(index - props.overscan)
})
const endIdx = computed(() => {
  const index = binarySearch(accumulatedHeights.value, scrollY.value + wrapperHeight.value)
  return clampIndex((index >= 0 ? index + 1 : props.items.length) + props.overscan)
})

const showItems = computed(() => props.items.slice(startIdx.value, endIdx.value))
debouncedWatch(slotReferences.value, async () => {
  // 定高时高度已经是已知量，量 DOM 只会白白触发一次强制回流。
  if (!wrapper.value || props.itemHeight) {
    return
  }
  let dom = wrapper.value
  if (dom.$el) {
    dom = dom.$el
  }
  for (const element of dom?.querySelectorAll('.virtual-scroll-item') || []) {
    const height = (element as HTMLElement).clientHeight
    const dataIndex = Number((element as HTMLElement).dataset.index)
    calculatedHeightsTrue.value[dataIndex] = height
  }
}, {
  debounce: 100,
  immediate: true,
})

// 全是前缀和上的取下标 —— 原先 paddingTop 每次滚动都 slice + reduce 重算整个
// 前缀，在上万项时是纯浪费。
const remainHeight = computed(() => accumulatedHeights.value[props.items.length] - accumulatedHeights.value[endIdx.value])
const paddingTop = computed(() => accumulatedHeights.value[startIdx.value])
</script>

<template>
  <component
    :is="is"
    ref="wrapper"
    class="h-full overflow-auto"
  >
    <div
      :style="{
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${remainHeight}px`,
      }"
    >
      <div
        v-for="item, i of showItems"
        ref="slotReferences"
        :key="startIdx + i"
        :data-index="startIdx + i"
        class="virtual-scroll-item"
      >
        <slot
          :item="item"
          :index="startIdx + i"
        />
      </div>
    </div>
  </component>
</template>
