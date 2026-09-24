<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { useRovingFocus } from '@/composables/useRovingFocus'

// One dimension's choices as a radio group: one Tab stop, ←/→ move focus,
// Space/Enter pick. Arrows deliberately do NOT check (APG "manual activation"):
// picking commits a judgement and may advance to the next image, so it must never
// happen as a side effect of moving focus.
//
// @mousedown.prevent keeps a mouse click from parking focus on the button. The
// session's Space (skip) hotkey yields to a focused button, so a clicked choice would
// otherwise turn the next Space into "pick this again" on the next image.
const props = defineProps<{
  labelledby: string
  options: { label: string, key: string }[]
  /** 1-based checked value, or null. */
  checked: number | null | undefined
}>()
const emit = defineEmits<{ select: [value: number] }>()

const group = useTemplateRef<HTMLElement>('group')
useRovingFocus({ container: group, itemSelector: '[role=radio]', orientation: 'horizontal' })

function isChecked(i: number) {
  return props.checked === i + 1
}
</script>

<template>
  <div ref="group" role="radiogroup" :aria-labelledby="labelledby" class="mt-3 flex gap-1.5">
    <button
      v-for="(opt, i) in options"
      :key="i"
      type="button"
      role="radio"
      class="annotate-choice"
      :class="{ 'annotate-choice--active': isChecked(i) }"
      :aria-checked="isChecked(i)"
      :aria-keyshortcuts="opt.key"
      @mousedown.prevent
      @click="emit('select', i + 1)"
    >
      <kbd aria-hidden="true">{{ opt.key }}</kbd>
      <span>{{ opt.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.annotate-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  font-size: var(--p-text-sm);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast),
    color var(--p-transition-fast),
    transform var(--p-transition-fast);
}
.annotate-choice:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.55);
  color: var(--p-fg);
}
.annotate-choice:active {
  transform: scale(0.96);
}
.annotate-choice--active {
  background: var(--p-primary);
  border-color: var(--p-primary);
  color: white;
}
.annotate-choice kbd {
  font-family: var(--p-font-mono);
  font-size: 10px;
  opacity: 0.65;
}
</style>
