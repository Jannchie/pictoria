<script setup lang="ts" generic="T extends string | number">
import { useTemplateRef } from 'vue'
import { useRovingFocus } from './useRovingFocus'

// A segmented single choice: an APG radio group drawn as a row of segments.
// One Tab stop; arrows move AND select (automatic activation — use it for plain
// settings where nothing is committed until a later action), Home / End jump,
// Space / Enter / click select too. Labels and titles come from the caller
// (already translated). Name the group with `aria-labelledby` (or `aria-label`);
// `aria-describedby` / `id` / `class` fall through to the radiogroup.
defineProps<{
  options: readonly { value: T, label: string, title?: string }[]
}>()
const model = defineModel<T>({ required: true })

const group = useTemplateRef<HTMLElement>('group')
useRovingFocus({ container: group, itemSelector: '[role=radio]', orientation: 'horizontal', onMove: el => el.click() })
</script>

<template>
  <div ref="group" role="radiogroup" class="p-segmented">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      class="p-segmented__item"
      :class="{ 'p-segmented__item--active': model === o.value }"
      :title="o.title"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.p-segmented {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  background: var(--p-surface-1);
}
.p-segmented__item {
  padding: 6px 14px;
  font-size: var(--p-text-sm);
  border-radius: calc(var(--p-radius-md) - 3px);
  color: var(--p-fg-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background-color var(--p-transition-fast),
    color var(--p-transition-fast);
}
.p-segmented__item:hover {
  color: var(--p-fg);
}
.p-segmented__item--active {
  color: var(--p-fg);
  background: rgb(var(--p-primary-rgb) / 0.22);
}
</style>
