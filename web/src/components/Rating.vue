<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  count?: number
  icons?: IconType
  colors?: string[]
  highlightSelectedOnly?: boolean
  unselectable?: boolean
}>()
const emit = defineEmits<{
  select: [number]
}>()
const count = computed(() => props.count ?? 5)
const model = defineModel({
  default: 0,
})
const highlightSelectedOnly = computed(() => {
  return props.highlightSelectedOnly ?? false
})
const unselectable = computed(() => {
  return props.unselectable ?? false
})
const hoverIndex = ref(-1)
const defaultIcon = 'i-tabler-star'
const defaultActionIcon = 'i-tabler-star-filled'
const defaultColor = '#EA580C'

type IconType = string | { active: string, normal: string } | (string | { active: string, normal: string })[] | undefined
const iconData = computed(() => {
  return unifyInput(props.icons, count.value, defaultIcon, defaultActionIcon)
})
function unifyInput(
  input: IconType,
  n: number,
  defaultNormalIcon: string,
  defaultActiveIcon: string,
): { active: string, normal: string }[] {
  // Helper function to convert a string to { active, normal } object using default values
  function toActiveNormal(value: string | { active: string, normal: string } | undefined): { active: string, normal: string } {
    if (typeof value === 'string') {
      return { active: value, normal: value }
    }
    else if (value === undefined) {
      return { active: defaultActiveIcon, normal: defaultNormalIcon }
    }
    else {
      return {
        active: value.active || defaultActiveIcon,
        normal: value.normal || defaultNormalIcon,
      }
    }
  }

  // If input is undefined, use default values for all elements
  if (input === undefined) {
    return Array.from<{ active: string, normal: string }>({ length: n }).fill({ active: defaultActiveIcon, normal: defaultNormalIcon })
  }

  // Determine the base object to use for filling the array
  let baseObject: { active: string, normal: string }

  if (typeof input === 'string') {
    baseObject = { active: input, normal: input }
  }
  else if (Array.isArray(input)) {
    const normalizedArray = input.map(item => toActiveNormal(item))
    if (normalizedArray.length === 1) {
      // If the array only contains one element, use it to fill all elements
      baseObject = normalizedArray[0]
      return Array.from<{ active: string, normal: string }>({ length: n }).fill(baseObject)
    }
    else {
      // If the array contains multiple elements, ensure it has exactly `n` elements
      return normalizedArray
        .slice(0, n) // Use existing elements up to n
        .concat( // Fill remaining with default values
          Array.from<{ active: string, normal: string }>({ length: Math.max(0, n - normalizedArray.length) }).fill({ active: defaultActiveIcon, normal: defaultNormalIcon }),
        )
    }
  }
  else {
    baseObject = {
      active: input.active || defaultActiveIcon,
      normal: input.normal || defaultNormalIcon,
    }
  }

  // Create an array with `n` elements, all being `baseObject`
  return Array.from<{ active: string, normal: string }>({ length: n }).fill(baseObject)
}
const activeCls = 'text-orange-6'
const inactiveCls = 'text-surface-dimmed'
const hoverCls = 'text-orange-6'
function getCls(idx: number) {
  const normalIcon = iconData.value[idx].normal
  const activeIcon = iconData.value[idx].active
  if (highlightSelectedOnly.value) {
    if (hoverIndex.value !== -1) {
      if (hoverIndex.value === idx + 1) {
        return [hoverCls, activeIcon]
      }
      return [inactiveCls, normalIcon]
    }
    else {
      if (model.value === idx + 1) {
        return [activeCls, activeIcon]
      }
      return [inactiveCls, normalIcon]
    }
  }
  if (hoverIndex.value !== -1) {
    if (hoverIndex.value > idx) {
      return [hoverCls, activeIcon]
    }
    else {
      return [inactiveCls, normalIcon]
    }
  }
  else {
    if (model.value >= idx + 1) {
      return [activeCls, activeIcon]
    }
    return [inactiveCls, normalIcon]
  }
}
const colors = computed(() => {
  const resp = Array.from({ length: count.value }).map(() => defaultColor)
  if (!props.colors) {
    return resp
  }
  props.colors.forEach((d, i) => {
    if (d) {
      resp[i] = d
    }
  })
  return resp
})
function getStyle(idx: number) {
  const activeColor = colors.value[idx]
  if (highlightSelectedOnly.value) {
    if (hoverIndex.value !== -1) {
      if (hoverIndex.value === idx + 1) {
        return { color: activeColor }
      }
      return { color: '#666F' }
    }
    else {
      if (model.value === idx + 1) {
        return { color: activeColor }
      }
      return { color: '#666F' }
    }
  }
  if (hoverIndex.value !== -1) {
    if (hoverIndex.value > idx) {
      return { color: activeColor }
    }
    else {
      return { color: '#666F' }
    }
  }
  else {
    if (model.value >= idx + 1) {
      return { color: activeColor }
    }
    return { color: '#666F' }
  }
}
function onPointerDown(i: number) {
  if (model.value === i && unselectable.value) {
    emit('select', 0)
    model.value = 0
  }
  else {
    emit('select', i + 1)
    model.value = i + 1
  }
}
</script>

<template>
  <div class="flex cursor-pointer">
    <div
      v-for="_, i in count"
      :key="i"
      class="pr-1"
      @mouseover="hoverIndex = i + 1"
      @mouseleave="hoverIndex = -1"
      @pointerdown="onPointerDown(i)"
    >
      <i
        :class="getCls(i)"
        :style="getStyle(i)"
      />
    </div>
  </div>
</template>
