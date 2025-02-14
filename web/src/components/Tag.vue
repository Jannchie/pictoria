<script setup lang="ts">
import { generateColorsMap } from '@roku-ui/vue'
import tinycolor from 'tinycolor2'
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  color?: string
  variant?: 'filled' | 'outlined' | 'light'
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full' | string | number
}>(), {
  variant: 'light',
  rounded: 'md',
})

const rounded = useRounded(props)

const colorObj = computed(() => {
  return tinycolor(props.color)
})
const colors = computed(() => {
  return generateColorsMap(colorObj.value.toHexString(), [0.98, 0.96, 0.9, 0.7, 0.5, 0.4, 0.35, 0.3, 0.28, 0.2, 0.08]).colors
})

const colorStyle = computed(() => {
  switch (props.variant) {
    case 'light':
    {
      const bgColor = tinycolor(colors.value[5]).setAlpha(0.25)
      return {
        backgroundColor: bgColor.toHex8String(),
        color: colors.value[3],
        borderColor: 'transparent',
      }
    }
    case 'outlined':
      return {
        borderColor: colors.value[3],
        color: colors.value[3],
      }
    case 'filled':
    default:
      return {
        backgroundColor: colors.value[7],
        color: tinycolor.mostReadable(colors.value[7], colors.value).toHexString(),
      }
  }
})

function useRounded(props: { rounded: 'none' | 'sm' | 'md' | 'lg' | 'full' | string | number }) {
  return computed(() => {
    const style = getRoundedStyle(props.rounded)
    return { style, class: 'rounded-[var(--r-rounded)]' }
  },
  )
}

function getRoundedStyle(rounded: 'none' | 'sm' | 'md' | 'lg' | 'full' | string | number) {
  const regex = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|vh|vw|in|cm|mm|pt|pc|%)?$/
  switch (rounded) {
    case 'none':
      return '--r-rounded: 0'
    case 'sm':
      return '--r-rounded: 0.125rem'
    case 'md':
      return '--r-rounded: 0.25rem'
    case 'lg':
      return '--r-rounded: 0.5rem'
    case 'full':
      return '--r-rounded: 9999px'
    default:
      if (typeof rounded === 'string' && regex.test(rounded)) {
        return `--r-rounded: ${rounded};`
      }
      if (typeof rounded === 'number' || !Number.isNaN(Number(rounded))) {
        return `--r-rounded: ${rounded}rem;`
      }
      return 'rounded-[var(--r-rounded)]'
  }
}
</script>

<template>
  <div
    :style="[colorStyle, rounded.style]"
    :class="rounded.class"
    class="border rounded px-1.5 py-0.5 text-xs"
  >
    <slot />
  </div>
</template>
