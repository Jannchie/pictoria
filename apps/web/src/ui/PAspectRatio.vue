<script setup lang="ts">
withDefaults(defineProps<{
  ratio?: number
}>(), {
  ratio: 1,
})
</script>

<template>
  <div class="p-ar" :style="{ aspectRatio: String(ratio) }">
    <slot />
  </div>
</template>

<style scoped>
.p-ar {
  display: block;
  position: relative;
  width: 100%;
}
.p-ar > :slotted(*) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
