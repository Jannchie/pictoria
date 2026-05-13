<script setup lang="ts">
type Level = 'base' | '1' | '2' | '3'

withDefaults(defineProps<{
  level?: Level
  bordered?: boolean
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | 'none'
  padded?: boolean
  shadow?: 'none' | 'sm' | 'md' | 'lg'
}>(), {
  level: '1',
  rounded: 'md',
  shadow: 'none',
})
</script>

<template>
  <div
    class="p-surface"
    :class="[
      `p-surface--lv-${level}`,
      `p-surface--r-${rounded}`,
      `p-surface--sh-${shadow}`,
      { 'p-surface--bordered': bordered, 'p-surface--padded': padded },
    ]"
  >
    <slot />
  </div>
</template>

<style scoped>
.p-surface { color: var(--p-fg); }

.p-surface--lv-base { background: var(--p-bg); }
.p-surface--lv-1    { background: var(--p-surface); }
.p-surface--lv-2    { background: var(--p-surface-1); }
.p-surface--lv-3    { background: var(--p-surface-2); }

.p-surface--r-none { border-radius: 0; }
.p-surface--r-sm   { border-radius: var(--p-radius-sm); }
.p-surface--r-md   { border-radius: var(--p-radius-md); }
.p-surface--r-lg   { border-radius: var(--p-radius-lg); }
.p-surface--r-xl   { border-radius: var(--p-radius-xl); }

.p-surface--bordered { border: 1px solid var(--p-border); }
.p-surface--padded   { padding: var(--p-space-4); }

.p-surface--sh-none {}
.p-surface--sh-sm   { box-shadow: var(--p-shadow-sm); }
.p-surface--sh-md   { box-shadow: var(--p-shadow-md); }
.p-surface--sh-lg   { box-shadow: var(--p-shadow-lg); }
</style>
