<script setup lang="ts" generic="T">
defineProps<{
  items: T[]
}>()
defineExpose({})
const positionClass = 'fixed top-25 w-full items-center z-1000'
const layoutClass = 'flex flex-col gap-2'
</script>

<template>
  <div :class="[positionClass, layoutClass]">
    <div
      v-for="item, i in items"
      :key="i"
    >
      <slot :item="item" />
    </div>
  </div>
</template>
