<script setup lang="ts">
withDefaults(defineProps<{
  opacity?: number
}>(), {
  opacity: 0.4,
})
</script>

<template>
  <div
    class="p-overlay"
    :style="{ background: `rgb(0 0 0 / ${opacity})` }"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>

<style scoped>
.p-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--p-z-overlay);
}
</style>
