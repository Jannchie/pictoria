<script setup lang="ts" generic="T">
defineProps<{
  items: T[]
}>()
defineExpose({})
const positionClass = 'fixed top-25 w-full items-center z-[var(--p-z-toast)]'
const layoutClass = 'flex flex-col gap-2'
</script>

<template>
  <div
    role="region"
    aria-label="Notifications"
    aria-live="polite"
    :class="[positionClass, layoutClass]"
    style="padding-top: env(safe-area-inset-top, 0);"
  >
    <div
      v-for="item, i in items"
      :key="i"
    >
      <slot :item="item" />
    </div>
  </div>
</template>
