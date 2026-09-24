<script setup lang="ts">
import { computed, ref, useId } from 'vue'

const props = defineProps<{
  count?: number
  icons?: IconType
  colors?: string[]
  highlightSelectedOnly?: boolean
  /** Clicking the selected star again, or Delete / Backspace, clears to 0. */
  unselectable?: boolean
  ariaLabel?: string
  /** No interaction; out of the Tab order (like a disabled native radio group). */
  disabled?: boolean
  /** Focusable and announced, arrows move focus, but the value can't change. */
  readonly?: boolean
  /**
   * The value differs across a multi-selection: no star is checked and the
   * group is described as "mixed". Picking any star (including the one the
   * model currently holds) selects it.
   */
  mixed?: boolean
}>()
const emit = defineEmits<{
  select: [number]
}>()
const count = computed(() => props.count ?? 5)
const model = defineModel<number>({
  default: 0,
})
const highlightSelectedOnly = computed(() => {
  return props.highlightSelectedOnly ?? false
})
const unselectable = computed(() => {
  return props.unselectable ?? false
})
const hoverIndex = ref(-1)
// What the stars draw: nothing while the value is mixed.
const shown = computed(() => props.mixed ? 0 : model.value)
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
      if (shown.value === index + 1) {
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
    if (shown.value >= index + 1) {
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
      if (shown.value === index + 1) {
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
    if (shown.value >= index + 1) {
      return { color: activeColor }
    }
    return { color: inactiveColor }
  }
  else {
    return hoverIndex.value > index ? { color: activeColor } : { color: inactiveColor }
  }
}
const interactive = computed(() => !props.disabled && !props.readonly)

/** Set the value; a no-op (no `select` emit) when it wouldn't change anything. */
function setValue(value: number) {
  if (!interactive.value || (value === model.value && !props.mixed)) {
    return
  }
  emit('select', value)
  model.value = value
}

// Pointer / assistive-tech activation (`click`, so screen-reader and voice
// control synthetic clicks work too). Clicking the selected star toggles it
// off when `unselectable` — a pointer affordance only; keys never clear.
function onClick(index: number) {
  if (!interactive.value) {
    return
  }
  if (unselectable.value && model.value === index + 1 && !props.mixed) {
    setValue(0)
    return
  }
  setValue(index + 1)
}

function onKeyDown(e: KeyboardEvent, index: number) {
  if (props.disabled || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) {
    return
  }
  // Arrows move focus and (APG radio group) check the focused star; in
  // readonly mode they only move focus.
  const moveTo = (next: number) => {
    e.preventDefault()
    if (props.readonly) {
      focusStar(next)
      return
    }
    setValue(next + 1)
    focusStar(next)
  }
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown': {
      moveTo(Math.max(0, index - 1))
      break
    }
    case 'ArrowRight':
    case 'ArrowUp': {
      moveTo(Math.min(count.value - 1, index + 1))
      break
    }
    case 'Home': {
      moveTo(0)
      break
    }
    case 'End': {
      moveTo(count.value - 1)
      break
    }
    case ' ':
    case 'Enter': {
      e.preventDefault()
      if (!e.repeat) {
        setValue(index + 1)
      }
      break
    }
    case 'Delete':
    case 'Backspace': {
      if (unselectable.value && interactive.value) {
        e.preventDefault()
        setValue(0)
      }
      break
    }
  }
}

const rootRef = ref<HTMLElement | null>(null)
function focusStar(index: number) {
  const el = rootRef.value?.querySelectorAll<HTMLElement>('[role="radio"]')[index]
  el?.focus()
}

function isChecked(index: number) {
  return !props.mixed && model.value === index + 1
}
// One Tab stop: the checked star, else the first.
function tabStop(index: number) {
  if (props.disabled) {
    return -1
  }
  const checked = !props.mixed && model.value > 0 && model.value <= count.value
  return (checked ? model.value - 1 === index : index === 0) ? 0 : -1
}

const mixedId = useId()
</script>

<template>
  <div
    ref="rootRef"
    role="radiogroup"
    :aria-label="ariaLabel ?? $t('rating.aria')"
    :aria-describedby="mixed ? mixedId : undefined"
    :aria-disabled="disabled || undefined"
    :aria-readonly="readonly || undefined"
    class="flex"
    :class="{ 'op-50': disabled }"
  >
    <span v-if="mixed" :id="mixedId" class="sr-only">{{ $t('rating.mixed') }}</span>
    <div
      v-for="_, i in count"
      :key="i"
      role="radio"
      :aria-checked="isChecked(i)"
      :aria-disabled="disabled || undefined"
      :aria-label="$t('rating.option', { n: i + 1, count })"
      :tabindex="tabStop(i)"
      class="pr-1 rounded"
      :class="interactive ? 'cursor-pointer' : disabled ? 'cursor-not-allowed' : 'cursor-default'"
      @mouseover="interactive && (hoverIndex = i + 1)"
      @mouseleave="hoverIndex = -1"
      @click="onClick(i)"
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
