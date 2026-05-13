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
  <div class="w-96 inline-flex items-center gap-2 border border-border-default rounded-xl bg-surface px-4 py-2 text-sm text-fg shadow-lg">
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
      class="flex flex-shrink-0 items-center rounded p-0.5 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      <i class="i-tabler-x" />
    </button>
  </div>
</template>
