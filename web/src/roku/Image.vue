<script setup lang="ts">
import type { Component } from 'vue'
import { computed, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    is?: string | Component
    src?: string
    lazySrc?: string
    style?: any
    class?: any
    width?: string | number
    maxWidth?: string | number
    height?: string | number
    maxHeight?: string | number
    rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full' | string | number
    alt?: string
  }>(),
  {
    is: 'img',
    rounded: 'none',
  },
)

const loaded = ref(false)
const img = ref<HTMLImageElement | null>(null)
function onload() {
  loaded.value = true
}
onMounted(() => {
  if (img.value?.complete) {
    onload()
  }
})

const roundedToken = computed(() => {
  const r = props.rounded
  if (typeof r === 'number') {
    return `${r}px`
  }
  switch (r) {
    case 'none': { return '0'
    }
    case 'sm': { return 'var(--p-radius-sm)'
    }
    case 'md': { return 'var(--p-radius-md)'
    }
    case 'lg': { return 'var(--p-radius-lg)'
    }
    case 'full': { return 'var(--p-radius-full)'
    }
    default: { return r
    }
  }
})
const roundedStyle = computed(() => ({ borderRadius: roundedToken.value }))
</script>

<template>
  <div
    class="inline relative"
    :style="[roundedStyle]"
  >
    <Transition
      enter-active-class="transition-opacity duration-300"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
    >
      <component
        :is="is"
        v-show="loaded"
        ref="img"
        :style="[style, roundedStyle]"
        :src="src"
        class="h-full w-full object-cover"
        :class="[props.class]"
        :alt="props.alt"
        v-bind="$attrs"
        @load="onload"
      />
    </Transition>
    <template v-if="!loaded">
      <div
        v-if="!props.lazySrc"
        class="bg-surface h-full w-full top-0 absolute animate-pulse object-cover"
        :class="[props.class]"
        :style="[style, roundedStyle]"
      />
    </template>
  </div>
</template>
