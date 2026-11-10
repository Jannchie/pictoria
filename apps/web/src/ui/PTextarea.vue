<script setup lang="ts">
import { nextTick, onMounted, useTemplateRef, watch } from 'vue'

/**
 * Multi-line text field that grows with its content (up to `maxRows`, then
 * scrolls). Same frame as `PInput`: border highlights on focus instead of a
 * ring, `invalid` → `aria-invalid` + danger border. Committing (blur,
 * Mod+Enter…) is the caller's business — this only reports `update:modelValue`.
 */
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  size?: 'sm' | 'md'
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  ariaLabel?: string
  ariaLabelledby?: string
  ariaDescribedby?: string
  invalid?: boolean
  /** Visible rows when empty. */
  minRows?: number
  /** Grow up to this many rows, then scroll. */
  maxRows?: number
}>(), {
  size: 'md',
  minRows: 1,
  maxRows: 12,
})

const model = defineModel<string>({ default: '' })
const field = useTemplateRef<HTMLTextAreaElement>('field')

function resize() {
  const el = field.value
  if (!el) {
    return
  }
  const style = getComputedStyle(el)
  const line = Number.parseFloat(style.lineHeight) || 16
  const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
  const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
  el.style.height = 'auto'
  const min = line * props.minRows + pad + border
  const max = line * props.maxRows + pad + border
  const wanted = el.scrollHeight + border
  el.style.height = `${Math.min(max, Math.max(min, wanted))}px`
  el.style.overflowY = wanted > max ? 'auto' : 'hidden'
}

onMounted(resize)
watch(model, () => nextTick(resize))

defineExpose({
  focus: (options?: FocusOptions) => field.value?.focus(options),
  blur: () => field.value?.blur(),
  select: () => field.value?.select(),
})
</script>

<template>
  <textarea
    ref="field"
    class="p-textarea"
    :class="[`p-textarea--${size}`, { 'p-textarea--invalid': invalid }]"
    :value="model"
    :rows="minRows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :aria-label="ariaLabel"
    :aria-labelledby="ariaLabelledby"
    :aria-describedby="ariaDescribedby"
    :aria-invalid="invalid || undefined"
    v-bind="$attrs"
    @input="(e) => { model = (e.target as HTMLTextAreaElement).value; resize() }"
  />
</template>

<style scoped>
.p-textarea {
  display: block;
  width: 100%;
  min-width: 0;
  resize: none;
  background: var(--p-surface-1);
  color: var(--p-fg);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  padding: var(--p-space-1) var(--p-control-px-sm);
  font: inherit;
  outline: none;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
.p-textarea:hover:not(:disabled) {
  border-color: var(--p-border-strong);
}
.p-textarea:focus,
.p-textarea:focus-visible {
  outline: none;
  border-color: var(--p-primary);
  background: var(--p-bg);
}
.p-textarea--invalid,
.p-textarea--invalid:hover:not(:disabled),
.p-textarea--invalid:focus {
  border-color: var(--p-danger);
}
.p-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.p-textarea::placeholder {
  color: var(--p-fg-subtle);
}
.p-textarea--sm { font-size: var(--p-text-xs); line-height: 1.5; }
.p-textarea--md { font-size: var(--p-text-base); line-height: 1.5; }

@media (prefers-reduced-motion: reduce) {
  .p-textarea { transition: none; }
}
</style>
