<script setup lang="ts">
defineProps<{
  label?: string
}>()

const model = defineModel<boolean | undefined>({ default: undefined })
</script>

<template>
  <label class="p-checkbox inline-flex cursor-pointer items-center">
    <input
      v-model="model"
      type="checkbox"
      class="p-checkbox__input sr-only"
    >
    <span
      class="p-checkbox__box text-on-primary rounded-xs flex h-3.5 w-3.5 inline-block transition-colors items-center justify-center"
      :class="[{
        'bg-primary hover:bg-primary-hover': modelValue,
        'bg-surface-1 border border-border-default': !modelValue,
      }]"
      aria-hidden="true"
    >
      <i
        v-if="modelValue"
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
   :focus-visible ring would be invisible — forward it to the box instead. */
.p-checkbox__input:focus-visible + .p-checkbox__box {
  outline: var(--p-focus-ring);
  outline-offset: 1px;
}
</style>
