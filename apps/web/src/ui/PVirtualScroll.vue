<script setup lang="ts" generic="T">
import type { Component } from 'vue'
import { controlledComputed, debouncedWatch, useElementBounding, useScroll } from '@vueuse/core'
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  is?: Component | string
  items?: T[]
  itemHeight?: number
}>(), {
  items: () => [],
  is: 'div',
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

const calculatedHeights = computed(() => {
  return props.items.map((_, index) => {
    if (calculatedHeightsTrue.value[index]) {
      return calculatedHeightsTrue.value[index]
    }
    return avgHeight.value
  })
})

const accumulatedHeights = controlledComputed(() => {
  return [calculatedHeights.value]
}, () => {
  const heights = calculatedHeights.value
  const accumulated = Array.from({ length: heights.length }) as number[]
  accumulated[0] = 0 // 初始值
  for (let index = 1; index < heights.length; index++) {
    accumulated[index] = accumulated[index - 1] + heights[index - 1]
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

const currentStartIdx = controlledComputed(() => {
  return [scrollY.value, accumulatedHeights.value]
}, () => {
  if (scrollY.value === 0) {
    return 0
  }
  const index = binarySearch(accumulatedHeights.value, scrollY.value) - 1
  return index >= 0 ? index : accumulatedHeights.value.length
})
const currentEndIndex = computed(() => {
  if (scrollY.value + wrapperHeight.value === 0) {
    return 0
  }
  const index = binarySearch(accumulatedHeights.value, scrollY.value + wrapperHeight.value)
  return index >= 0 ? index + 1 : accumulatedHeights.value.length
})

const showItems = computed(() => props.items.slice(currentStartIdx.value, currentEndIndex.value))
debouncedWatch(slotReferences.value, async () => {
  if (!wrapper.value) {
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

const remainHeight = computed(() => {
  if (!accumulatedHeights.value[currentEndIndex.value]) {
    return 0
  }
  const lastHeight = accumulatedHeights.value.at(-1)
  if (lastHeight === undefined) {
    return 0
  }
  return Math.max(0, lastHeight - accumulatedHeights.value[currentEndIndex.value])
})
const paddingTop = computed(() => calculatedHeights.value.slice(0, currentStartIdx.value).reduce((a, b) => a + b, 0))
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
        :key="currentStartIdx + i"
        :data-index="currentStartIdx + i"
        class="virtual-scroll-item"
      >
        <slot
          :item="item"
          :index="currentStartIdx + i "
        />
      </div>
    </div>
  </component>
</template>
