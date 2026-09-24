<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from 'vue'

const props = defineProps<{
  label?: string
  disabled?: boolean
  /** Tri-state "some but not all": dash glyph, `aria-checked="mixed"`. Caller-owned — re-asserted on every change. */
  indeterminate?: boolean
  name?: string
  value?: string
  ariaLabel?: string
  ariaLabelledby?: string
  /**
   * Purely visual box inside a row that already carries the checked state
   * itself (e.g. a `role="menuitemcheckbox"` / `option` row with
   * `aria-checked`): the native input leaves the Tab order and the
   * accessibility tree, so the state isn't announced twice and the row stays
   * the single focus target.
   */
  presentational?: boolean
}>()

const model = defineModel<boolean | undefined>({ default: undefined })
const input = useTemplateRef<HTMLInputElement>('input')

// `indeterminate` is a DOM property with no content attribute; the browser
// maps it to aria-checked="mixed" by itself.
// Re-applied after each toggle too: clicking clears the DOM flag natively,
// but the caller still owns it.
watchEffect(() => {
  void model.value
  if (input.value) {
    input.value.indeterminate = !!props.indeterminate
  }
}, { flush: 'post' })

const checked = computed(() => !!model.value)
const mixed = computed(() => !!props.indeterminate)
</script>

<template>
  <label
    class="p-checkbox inline-flex items-center"
    :class="disabled ? 'p-checkbox--disabled cursor-not-allowed' : 'cursor-pointer'"
    :aria-hidden="presentational || undefined"
  >
    <input
      ref="input"
      v-model="model"
      type="checkbox"
      class="p-checkbox__input sr-only"
      :disabled="disabled"
      :name="name"
      :value="value"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
      :tabindex="presentational ? -1 : undefined"
    >
    <span
      class="p-checkbox__box text-on-primary rounded-xs flex h-3.5 w-3.5 inline-block transition-colors items-center justify-center"
      :class="[{
        'bg-primary hover:bg-primary-hover': checked || mixed,
        'bg-surface-1 border border-border-default': !checked && !mixed,
      }]"
      aria-hidden="true"
    >
      <i
        v-if="mixed"
        class="i-tabler-minus h-3 w-3 block"
      />
      <i
        v-else-if="checked"
        class="i-tabler-check h-3 w-3 block"
      />
    </span>
    <span
      v-if="label"
      class="text-fg ml-2"
    >
      {{ label }}
    </span>
  </label>
</template>

<style scoped>
/* Focus lands on the visually-hidden (sr-only) input, so the unified
   :focus-visible ring would be invisible — forward it to the box instead.
   Both elements are in this component's template, so the scoped attribute
   is on each and the sibling selector matches. */
.p-checkbox__input:focus-visible + .p-checkbox__box {
  outline: var(--p-focus-ring);
  outline-offset: 1px;
}
.p-checkbox--disabled {
  opacity: 0.5;
}
</style>
