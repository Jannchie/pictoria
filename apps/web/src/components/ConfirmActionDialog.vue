<script setup lang="ts" generic="T">
import type { ConfirmAction } from '@/composables/useConfirmAction'
import { POverlay } from '@/ui'
import PDialog from '@/ui/PDialog.vue'

// A `useConfirmAction` rendered as a modal: shown while the action has a
// target, busy while it runs. Every way out (overlay click, Escape, Cancel)
// goes through `action.cancel`, which is a no-op while running, so an
// in-flight action can't be dismissed. Confirm emits the target; the caller
// runs `action.confirm(...)`. The default slot gets `target` for the body.
withDefaults(defineProps<{
  action: ConfirmAction<T>
  title: string
  /** Confirm button label; a function gets the target (e.g. for a count). */
  confirmLabel: string | ((target: T) => string)
  /** Confirm button label while the action runs. */
  busyLabel?: string
  cancelLabel?: string
  variant?: 'primary' | 'danger'
}>(), {
  variant: 'danger',
})

const emit = defineEmits<{
  confirm: [target: T]
}>()

defineSlots<{
  default: (props: { target: T }) => unknown
}>()
</script>

<template>
  <POverlay
    v-if="action.target.value !== null"
    class="flex items-center justify-center"
    @click.self="action.cancel()"
  >
    <PDialog
      :title="title"
      :confirm-label="action.isRunning.value && busyLabel
        ? busyLabel
        : typeof confirmLabel === 'function' ? confirmLabel(action.target.value) : confirmLabel"
      :cancel-label="cancelLabel ?? $t('common.cancel')"
      :variant="variant"
      :busy="action.isRunning.value"
      @confirm="emit('confirm', action.target.value)"
      @cancel="action.cancel()"
    >
      <slot :target="action.target.value" />
    </PDialog>
  </POverlay>
</template>
