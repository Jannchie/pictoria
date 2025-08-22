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
      class="text-white rounded flex h-3.5 w-3.5 inline-block items-center justify-center"
      :class="[{
        'bg-primary hover:bg-primary': modelValue,
        'bg-surface-variant-2 border border-surface-variant': !modelValue,
      }]"
    >
      <i
        v-if="modelValue"
        class="i-tabler-check"
      />
    </span>
    <span
      v-if="label"
      class="text-gray-700 ml-2"
    >
      {{ label }}
    </span>
  </label>
</template>
