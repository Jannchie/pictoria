<script setup lang="ts">
withDefaults(defineProps<{
  color: string
  size?: number | string
  bordered?: boolean
  rounded?: 'sm' | 'md' | 'lg' | 'full'
  /**
   * Accessible name (e.g. the colour's hex or name) when the swatch conveys
   * information on its own → `role="img"`. Without it the swatch is
   * decorative and hidden from assistive tech.
   */
  label?: string
}>(), {
  size: 16,
  rounded: 'sm',
})
</script>

<template>
  <span
    class="p-swatch"
    :class="[`p-swatch--r-${rounded}`, { 'p-swatch--bordered': bordered }]"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    :style="{
      backgroundColor: color,
      width: typeof size === 'number' ? `${size}px` : size,
      height: typeof size === 'number' ? `${size}px` : size,
    }"
  />
</template>

<style scoped>
.p-swatch {
  display: inline-block;
  flex-shrink: 0;
}
.p-swatch--r-sm   { border-radius: var(--p-radius-sm); }
.p-swatch--r-md   { border-radius: var(--p-radius-md); }
.p-swatch--r-lg   { border-radius: var(--p-radius-lg); }
.p-swatch--r-full { border-radius: var(--p-radius-full); }
.p-swatch--bordered {
  border: 1px solid var(--p-border);
}
</style>
