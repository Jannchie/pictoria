<script setup lang="ts">
import { computed, useId, useSlots, useTemplateRef } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useHotkey } from '@/composables/useHotkey'
import { useLayer } from '@/shared/layers'
import { isWidgetTarget } from '@/utils/keyboard'

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
const props = withDefaults(defineProps<{
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

const slots = useSlots()
const titleId = useId()
const bodyId = useId()
const hasTitle = computed(() => !!props.title || !!slots.header)

const surface = useTemplateRef<{ $el?: HTMLElement }>('surface')
const confirmButton = useTemplateRef<{ $el?: HTMLElement }>('confirmButton')
const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')
const dialogEl = computed(() => surface.value?.$el ?? null)

const { isTop } = useLayer(true, {
  el: () => dialogEl.value,
  modal: true,
  onEscape: () => emit('cancel'),
})

useFocusTrap(dialogEl, true, {
  initialFocus: () => props.variant === 'danger'
    ? (cancelButton.value?.$el ?? dialogEl.value)
    : confirmButton.value?.$el,
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
  emit('confirm')
}

// Focus fell to <body> (e.g. the element that had it was removed): Enter
// still confirms, but only for the top-most dialog.
useHotkey('Enter', () => emit('confirm'), {
  when: () => isTop.value && document.activeElement === document.body,
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
