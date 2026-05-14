<script setup lang="ts">
defineProps<{
  message: string
  icon?: string
  iconColor?: string
  closeable?: boolean
  closeIcon?: boolean
}>()
</script>

<template>
  <div class="text-sm text-fg px-4 py-2 border border-border-default rounded-xl bg-surface inline-flex gap-2 w-96 shadow-lg items-center">
    <div
      v-if="icon"
      class="flex-shrink-0"
      :style="iconColor ? { color: iconColor } : undefined"
    >
      <i :class="icon" />
    </div>
    <div class="flex-grow">
      {{ message }}
    </div>
    <button
      v-if="closeable"
      class="text-fg-muted p-0.5 rounded flex flex-shrink-0 transition-colors items-center hover:text-fg hover:bg-surface-2"
    >
      <i class="i-tabler-x" />
    </button>
  </div>
</template>
