<script setup lang="ts">
import { computed, useId, useSlots, useTemplateRef, watch } from 'vue'
import { isWidgetTarget } from '@/utils/keyboard'
import { useLayer } from './layers'
import { useFocusTrap } from './useFocusTrap'
import { useHotkey } from './useHotkey'

// Modal dialog (APG "dialog (modal)" / "alertdialog" for variant=danger).
//
// - Layer: a `modal` layer on the stack while mounted — Escape → cancel,
//   `isAnyDialogOpen` is true, and (because callers wrap it in POverlay,
//   which teleports to <body>) the rest of the page is `inert`.
// - Focus: trapped inside; initial focus is the confirm button for
//   `primary`, but CANCEL for `danger` — a destructive action must never be
//   the Enter default. Focus goes back to whatever opened the dialog.
// - Enter fallback: Enter confirms only while focus sits on the dialog itself
//   or on non-interactive text inside it (never on a textarea, input, link or
//   button — those own Enter).
// - Busy: while `busy` (the confirmed action is in flight) the dialog cannot
//   be dismissed or re-confirmed — Escape, Enter and Cancel do nothing, and
//   the confirm button shows its loading state. A scrim click is the
//   caller's (components/ConfirmActionDialog.vue routes it through the
//   action's `cancel`, which is a no-op while running).
const props = withDefaults(defineProps<{
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'primary' | 'danger'
  busy?: boolean
}>(), {
  variant: 'primary',
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const slots = useSlots()
const titleId = useId()
const bodyId = useId()
const hasTitle = computed(() => !!props.title || !!slots.header)

const surface = useTemplateRef<{ $el?: HTMLElement }>('surface')
const confirmButton = useTemplateRef<{ $el?: HTMLElement }>('confirmButton')
const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')
const dialogEl = computed(() => surface.value?.$el ?? null)

// Every confirm / cancel path (Escape, Enter, both buttons) goes through these,
// so none can fire while `busy`.
function emitConfirm() {
  if (!props.busy) {
    emit('confirm')
  }
}
function emitCancel() {
  if (!props.busy) {
    emit('cancel')
  }
}

const { isTop } = useLayer(true, {
  el: () => dialogEl.value,
  modal: true,
  onEscape: emitCancel,
})

useFocusTrap(dialogEl, true, {
  initialFocus: () => props.variant === 'danger'
    ? (cancelButton.value?.$el ?? dialogEl.value)
    : confirmButton.value?.$el,
})

// Cancel is natively disabled while busy; if it held focus, hand focus to
// the confirm button first (pre-flush, before the DOM update) so it never
// falls to <body>.
watch(() => props.busy, (busy) => {
  const cancelEl = cancelButton.value?.$el
  if (busy && cancelEl && document.activeElement === cancelEl) {
    (confirmButton.value?.$el ?? dialogEl.value)?.focus()
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.keyCode === 229
    || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) {
    return
  }
  if (e.target !== dialogEl.value && isWidgetTarget(e.target)) {
    return
  }
  e.preventDefault()
  emitConfirm()
}

// Focus fell to <body> (e.g. the element that had it was removed): Enter
// still confirms, but only for the top-most dialog.
useHotkey('Enter', emitConfirm, {
  when: () => isTop.value && !props.busy && document.activeElement === document.body,
  repeat: false,
})
</script>

<template>
  <Transition appear name="p-float">
    <PSurface
      ref="surface"
      :role="variant === 'danger' ? 'alertdialog' : 'dialog'"
      aria-modal="true"
      :aria-labelledby="hasTitle ? titleId : undefined"
      :aria-describedby="bodyId"
      :aria-busy="busy || undefined"
      tabindex="-1"
      level="1"
      bordered
      shadow="md"
      class="text-sm p-4 flex flex-col gap-3 min-w-86"
      @keydown="onKeydown"
    >
      <div v-if="hasTitle" :id="titleId">
        <slot name="header">
          <div class="text-base text-fg font-semibold">
            {{ title }}
          </div>
        </slot>
      </div>
      <div :id="bodyId" class="text-fg-muted">
        <slot />
      </div>
      <slot name="footer">
        <div class="mt-1 flex gap-2 justify-end">
          <PButton
            v-if="cancelLabel"
            ref="cancelButton"
            variant="ghost"
            :disabled="busy"
            @click="emitCancel"
          >
            {{ cancelLabel }}
          </PButton>
          <PButton
            v-if="confirmLabel"
            ref="confirmButton"
            :variant="variant"
            :loading="busy"
            @click="emitConfirm"
          >
            {{ confirmLabel }}
          </PButton>
        </div>
      </slot>
    </PSurface>
  </Transition>
</template>
