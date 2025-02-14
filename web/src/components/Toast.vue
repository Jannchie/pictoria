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
  <div class="inline-block h-auto w-96 flex items-center gap-2 rounded-xl bg-black px-4 py-2">
    <div
      v-if="icon"
      class="flex-shrink-0"
    >
      <i
        :class="icon"
      />
    </div>
    <div class="flex-grow">
      {{ message }}
    </div>
    <div
      v-if="closeable"
      class="flex-shrink-0"
    >
      <i class="i-tabler-x" />
    </div>
  </div>
</template>
