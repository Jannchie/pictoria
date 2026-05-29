<script setup lang="ts">
defineProps<{
  message: string
  icon?: string
  iconColor?: string
  closeable?: boolean
  closeIcon?: boolean
}>()
const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <div
    role="status"
    class="text-sm text-fg px-4 py-2 border border-border-default rounded-xl bg-surface inline-flex gap-2 w-96 shadow-lg items-center"
  >
    <div
      v-if="icon"
      class="flex-shrink-0"
      aria-hidden="true"
      :style="iconColor ? { color: iconColor } : undefined"
    >
      <i :class="icon" />
    </div>
    <div class="flex-grow">
      {{ message }}
    </div>
    <button
      v-if="closeable"
      type="button"
      aria-label="Dismiss notification"
      class="text-fg-muted p-0.5 rounded flex flex-shrink-0 transition-colors items-center hover:text-fg focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 focus-visible:outline hover:bg-surface-2"
      @click="emit('close')"
    >
      <i class="i-tabler-x" aria-hidden="true" />
    </button>
  </div>
</template>
