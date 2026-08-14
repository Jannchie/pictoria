<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  count?: number
  icons?: IconType
  colors?: string[]
  highlightSelectedOnly?: boolean
  unselectable?: boolean
  ariaLabel?: string
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
const defaultColor = 'var(--p-primary)'

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
      return [
        ...normalizedArray.slice(0, n), // Use existing elements up to n
        // Fill remaining with default values
        ...Array.from<{ active: string, normal: string }>({ length: Math.max(0, n - normalizedArray.length) }).fill({ active: defaultActiveIcon, normal: defaultNormalIcon }),
      ]
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
const activeCls = 'text-primary'
const inactiveCls = 'text-fg-muted'
const hoverCls = 'text-fg'
const inactiveColor = 'var(--p-fg-subtle)'
function getCls(index: number) {
  const normalIcon = iconData.value[index].normal
  const activeIcon = iconData.value[index].active
  if (highlightSelectedOnly.value) {
    if (hoverIndex.value === -1) {
      if (model.value === index + 1) {
        return [activeCls, activeIcon]
      }
      return [inactiveCls, normalIcon]
    }
    else {
      if (hoverIndex.value === index + 1) {
        return [hoverCls, activeIcon]
      }
      return [inactiveCls, normalIcon]
    }
  }
  if (hoverIndex.value === -1) {
    if (model.value >= index + 1) {
      return [activeCls, activeIcon]
    }
    return [inactiveCls, normalIcon]
  }
  else {
    return hoverIndex.value > index ? [hoverCls, activeIcon] : [inactiveCls, normalIcon]
  }
}
const colors = computed(() => {
  const resp = Array.from({ length: count.value }).map(() => defaultColor)
  if (!props.colors) {
    return resp
  }
  for (const [index, d] of props.colors.entries()) {
    if (d) {
      resp[index] = d
    }
  }
  return resp
})
function getStyle(index: number) {
  const activeColor = colors.value[index]
  if (highlightSelectedOnly.value) {
    if (hoverIndex.value === -1) {
      if (model.value === index + 1) {
        return { color: activeColor }
      }
      return { color: inactiveColor }
    }
    else {
      if (hoverIndex.value === index + 1) {
        return { color: activeColor }
      }
      return { color: inactiveColor }
    }
  }
  if (hoverIndex.value === -1) {
    if (model.value >= index + 1) {
      return { color: activeColor }
    }
    return { color: inactiveColor }
  }
  else {
    return hoverIndex.value > index ? { color: activeColor } : { color: inactiveColor }
  }
}
function selectAt(index: number) {
  if (model.value === index + 1 && unselectable.value) {
    emit('select', 0)
    model.value = 0
  }
  else {
    emit('select', index + 1)
    model.value = index + 1
  }
}

function onPointerDown(index: number) {
  selectAt(index)
}

function onKeyDown(e: KeyboardEvent, index: number) {
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown': {
      e.preventDefault()
      const next = Math.max(0, index - 1)
      selectAt(next)
      focusStar(next)
      break
    }
    case 'ArrowRight':
    case 'ArrowUp': {
      e.preventDefault()
      const next = Math.min(count.value - 1, index + 1)
      selectAt(next)
      focusStar(next)
      break
    }
    case 'Home': {
      e.preventDefault()
      selectAt(0)
      focusStar(0)
      break
    }
    case 'End': {
      e.preventDefault()
      selectAt(count.value - 1)
      focusStar(count.value - 1)
      break
    }
    case ' ':
    case 'Enter': {
      e.preventDefault()
      selectAt(index)
      break
    }
  }
}

const rootRef = ref<HTMLElement | null>(null)
function focusStar(index: number) {
  const el = rootRef.value?.querySelectorAll<HTMLElement>('[role="radio"]')[index]
  el?.focus()
}
</script>

<template>
  <div
    ref="rootRef"
    role="radiogroup"
    :aria-label="ariaLabel ?? $t('rating.aria')"
    class="flex"
  >
    <div
      v-for="_, i in count"
      :key="i"
      role="radio"
      :aria-checked="model === i + 1"
      :aria-label="$t('rating.option', { n: i + 1, count })"
      :tabindex="(model > 0 ? model - 1 === i : i === 0) ? 0 : -1"
      class="pr-1 rounded cursor-pointer"
      @mouseover="hoverIndex = i + 1"
      @mouseleave="hoverIndex = -1"
      @pointerdown="onPointerDown(i)"
      @keydown="onKeyDown($event, i)"
    >
      <i
        aria-hidden="true"
        :class="getCls(i)"
        :style="getStyle(i)"
      />
    </div>
  </div>
</template>
