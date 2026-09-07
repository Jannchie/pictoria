<script setup lang="ts">
import { ref, useSlots } from 'vue'

type Size = 'sm' | 'md' | 'lg'
/**
 * `plain` 是「长在容器里」的输入框：没有自己的边框和底色，聚焦也不高亮。
 * 用在面板顶部那种本身已经有 border-b 划界的搜索行——再给它一层框，读起来
 * 就成了浮在面板上的另一个控件。
 */
type Variant = 'default' | 'plain'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  size?: Size
  variant?: Variant
  placeholder?: string
  disabled?: boolean
  readonly?: boolean
  type?: string
  name?: string
  autocomplete?: string
  inputmode?: 'text' | 'search' | 'email' | 'tel' | 'url' | 'numeric' | 'decimal' | 'none'
  spellcheck?: boolean
  ariaLabel?: string
  ariaLabelledby?: string
  /**
   * Stretch to fill the row. Needed as a prop because inheritAttrs:false
   * forwards any passed class to the inner <input>, so `class="w-full"`
   * can never reach the inline-flex root.
   */
  block?: boolean
}>(), {
  size: 'md',
  variant: 'default',
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
      `p-input--v-${variant}`,
      { 'p-input--focused': focused, 'p-input--disabled': disabled, 'p-input--block': block },
    ]"
  >
    <span v-if="hasLeft" class="p-input__slot p-input__slot--left" aria-hidden="true">
      <slot name="leftSection" />
    </span>
    <input
      class="p-input__field"
      :type="type"
      :value="model"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :name="name"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :spellcheck="spellcheck"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
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
  gap: var(--p-control-gap);
  background: var(--p-surface-1);
  color: var(--p-fg);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  padding: 0 var(--p-control-px-sm);
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
.p-input:hover:not(.p-input--disabled) {
  border-color: var(--p-border-strong);
}
/* Focus = the border, per the design-system focus rule (inputs highlight the
   border instead of drawing a ring) — no halo. */
.p-input--focused {
  border-color: var(--p-primary);
  background: var(--p-bg);
}
.p-input--v-plain,
.p-input--v-plain:hover:not(.p-input--disabled),
.p-input--v-plain.p-input--focused {
  background: transparent;
  border-color: transparent;
}
.p-input--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.p-input--sm { height: var(--p-control-h-sm); font-size: var(--p-text-xs); }
.p-input--md { height: var(--p-control-h-md); font-size: var(--p-text-base); }
.p-input--lg { height: var(--p-control-h-lg); font-size: var(--p-text-md); }

/* Fills a block container outright; in a flex row it grows/shrinks with
   the remaining space (siblings keep their shrink-0). */
.p-input--block {
  display: flex;
  width: 100%;
  flex: 1 1 auto;
  min-width: 0;
}

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

@media (prefers-reduced-motion: reduce) {
  .p-input { transition: none; }
}
</style>
