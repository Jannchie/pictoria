<script setup lang="ts">
import { openDialogCount } from './modal'

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

// Modal keyboard affordance: Enter = confirm, Escape = cancel. The confirm
// button is focused on mount so Enter/Space activate it natively; the window
// handlers below cover focus drifting back to <body> (e.g. after clicking
// the dialog text). When a button inside the dialog IS focused, Enter
// already clicks it — skip the fallback so a focused Cancel isn't overridden
// and confirm can't double-fire.
const confirmButton = ref<{ $el?: HTMLElement } | null>(null)
onMounted(() => confirmButton.value?.$el?.focus())

// While any PDialog is mounted, page-level hotkey guards (canHandle*Keys)
// stand down via this shared count — the handlers below can't swallow other
// window-level onKeyStroke listeners, so the gating happens at their guards.
onMounted(() => openDialogCount.value++)
onUnmounted(() => openDialogCount.value--)

onKeyStroke('Enter', (e) => {
  if (e.target instanceof HTMLElement && e.target.tagName === 'BUTTON') {
    return
  }
  e.preventDefault()
  emit('confirm')
})

onKeyStroke('Escape', (e) => {
  e.preventDefault()
  emit('cancel')
})
</script>

<template>
  <Transition appear name="p-float">
    <PSurface
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      level="1"
      bordered
      shadow="md"
      class="text-sm p-4 flex flex-col gap-3 min-w-86"
    >
      <slot name="header">
        <div v-if="title" class="text-base text-fg font-semibold">
          {{ title }}
        </div>
      </slot>
      <div class="text-fg-muted">
        <slot />
      </div>
      <slot name="footer">
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
            ref="confirmButton"
            :variant="variant"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </PButton>
        </div>
      </slot>
    </PSurface>
  </Transition>
</template>
