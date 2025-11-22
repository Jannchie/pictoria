<script setup lang="ts">
defineProps<{
  label?: string
}>()

const model = defineModel<boolean | undefined>({ default: undefined })
</script>

<template>
  <label class="inline-flex cursor-pointer items-center">
    <input
      v-model="model"
      type="checkbox"
      class="hidden"
    >
    <span
      class="text-inverted rounded flex h-3.5 w-3.5 inline-block transition-colors items-center justify-center"
      :class="[{
        'bg-primary hover:bg-primary': modelValue,
        'bg-container border border-base': !modelValue,
      }]"
    >
      <i
        v-if="modelValue"
        class="i-tabler-check"
      />
    </span>
    <span
      v-if="label"
      class="text-default ml-2"
    >
      {{ label }}
    </span>
  </label>
</template>
