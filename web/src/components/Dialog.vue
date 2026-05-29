<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'primary' | 'danger'
}>(), {
  variant: 'primary',
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <PSurface
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    level="1"
    bordered
    shadow="md"
    class="text-sm p-4 flex flex-col gap-3 min-w-86"
  >
    <div v-if="title" class="text-base text-fg font-semibold">
      {{ title }}
    </div>
    <div class="text-fg-muted">
      <slot />
    </div>
    <div class="mt-1 flex gap-2 justify-end">
      <PButton
        v-if="cancelLabel"
        variant="ghost"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </PButton>
      <PButton
        v-if="confirmLabel"
        :variant="variant"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </PButton>
    </div>
  </PSurface>
</template>
