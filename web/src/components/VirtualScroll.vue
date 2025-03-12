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
const slotRefs = ref<HTMLDivElement[]>([])

const wrapper = ref<any | null>(null)
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
  if (!heights.length) {
    return 20
  }

  // 过滤掉 falsy 值
  let sum = 0
  let count = 0

  for (let i = 0; i < heights.length; i++) {
    if (heights[i]) {
      sum += heights[i]
      count++
    }
  }
  return count === 0 ? 20 : sum / count
})

const calculatedHeights = computed(() => {
  return props.items.map((_, i) => {
    if (calculatedHeightsTrue.value[i]) {
      return calculatedHeightsTrue.value[i]
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
  for (let i = 1; i < heights.length; i++) {
    accumulated[i] = accumulated[i - 1] + heights[i - 1]
  }
  return accumulated
})

function binarySearch(arr: number[], target: number) {
  let start = 0
  let end = arr.length - 1
  if (target <= arr[0]) {
    return 0
  }

  while (start <= end) {
    const mid = Math.floor((start + end) / 2)
    if (arr[mid] < target && arr[mid + 1] >= target) {
      return mid + 1
    }
    else if (arr[mid] < target) {
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
  const idx = binarySearch(accumulatedHeights.value, scrollY.value) - 1
  return idx >= 0 ? idx : accumulatedHeights.value.length
})
const currentEndIdx = computed(() => {
  if (scrollY.value + wrapperHeight.value === 0) {
    return 0
  }
  const idx = binarySearch(accumulatedHeights.value, scrollY.value + wrapperHeight.value)
  return idx >= 0 ? idx + 1 : accumulatedHeights.value.length
})

const showItems = computed(() => props.items.slice(currentStartIdx.value, currentEndIdx.value))
debouncedWatch(slotRefs.value, async () => {
  if (!wrapper.value) {
    return
  }
  let dom = wrapper.value
  if (dom.$el) {
    dom = dom.$el
  }
  dom?.querySelectorAll('.virtual-scroll-item').forEach((el: HTMLElement) => {
    const height = el.clientHeight
    const dataIdx = Number(el.getAttribute('data-index'))
    calculatedHeightsTrue.value[dataIdx] = height
  })
}, {
  debounce: 100,
  immediate: true,
})

const remainHeight = computed(() => {
  if (!accumulatedHeights.value[currentEndIdx.value]) {
    return 0
  }
  return Math.max(0, accumulatedHeights.value[accumulatedHeights.value.length - 1] - accumulatedHeights.value[currentEndIdx.value])
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
        ref="slotRefs"
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
