<script setup lang="ts">
defineProps<{
  labelId: string
  icon: string
  title: string
  description?: string
  /** Prefix a corner marker so the row reads as a sub-setting of the one above. */
  child?: boolean
}>()
</script>

<template>
  <div class="px-5 py-4 flex gap-6 items-center justify-between">
    <div class="flex gap-3 min-w-0 items-center">
      <i v-if="child" class="i-tabler-corner-down-right text-sm text-fg-subtle shrink-0" aria-hidden="true" />
      <i :class="icon" class="text-lg text-fg-muted shrink-0" aria-hidden="true" />
      <div class="min-w-0">
        <h3 :id="labelId" class="text-fg font-medium">
          {{ title }}
        </h3>
        <p v-if="description" class="text-sm text-fg-muted mt-0.5 text-pretty">
          {{ description }}
        </p>
      </div>
    </div>
    <div class="shrink-0">
      <slot />
    </div>
  </div>
</template>
