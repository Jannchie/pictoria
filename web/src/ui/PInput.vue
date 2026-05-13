<script setup lang="ts">
import { ref, useSlots } from 'vue'

type Size = 'sm' | 'md' | 'lg'

withDefaults(defineProps<{
  size?: Size
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  type?: string
}>(), {
  size: 'md',
  type: 'text',
})

const model = defineModel<string | number | null | undefined>()
const slots = useSlots()
const focused = ref(false)
const hasLeft = !!slots.leftSection
const hasRight = !!slots.rightSection
</script>

<template>
  <label
    class="p-input"
    :class="[
      `p-input--${size}`,
      { 'p-input--focused': focused, 'p-input--disabled': disabled },
    ]"
  >
    <span v-if="hasLeft" class="p-input__slot p-input__slot--left">
      <slot name="leftSection" />
    </span>
    <input
      class="p-input__field"
      :type="type"
      :value="model"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      v-bind="$attrs"
      @input="(e) => model = (e.target as HTMLInputElement).value"
      @focus="focused = true"
      @blur="focused = false"
    >
    <span v-if="hasRight" class="p-input__slot p-input__slot--right">
      <slot name="rightSection" />
    </span>
  </label>
</template>

<style scoped>
.p-input {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--p-surface-1);
  color: var(--p-fg);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  padding: 0 10px;
  transition:
    border-color var(--p-duration-fast) var(--p-ease),
    box-shadow var(--p-duration-fast) var(--p-ease),
    background-color var(--p-duration-fast) var(--p-ease);
}
.p-input:hover:not(.p-input--disabled) {
  border-color: var(--p-border-strong);
}
.p-input--focused {
  border-color: var(--p-primary);
  box-shadow: 0 0 0 3px rgb(var(--p-primary-rgb) / 0.18);
}
.p-input--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.p-input--sm { height: 28px; font-size: var(--p-text-xs); }
.p-input--md { height: 36px; font-size: var(--p-text-base); }
.p-input--lg { height: 44px; font-size: var(--p-text-md); }

.p-input__field {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0;
}
.p-input__field::placeholder {
  color: var(--p-fg-subtle);
}

.p-input__slot {
  display: inline-flex;
  align-items: center;
  color: var(--p-fg-muted);
  flex-shrink: 0;
}
</style>
