<script setup lang="ts">
// Centered empty-state primitive: optional icon + a line of text + optional
// action area. No border / background / card — empty states live inline,
// matching the design system's "no nested panels" principle.
//
// The icon is a UnoCSS icon class (e.g. `i-tabler-photo-off`); the text comes
// from the default slot (callers pass their own `$t(...)` so PEmpty stays
// i18n-free). The root element carries layout utilities only, so callers can
// override spacing by passing a `class` (e.g. `class="py-4"` in popovers).
withDefaults(defineProps<{
  icon?: string
}>(), {
  icon: 'i-tabler-inbox',
})
</script>

<template>
  <div class="text-fg-subtle px-4 py-8 text-center flex flex-col gap-2 items-center justify-center">
    <i :class="icon" class="text-2xl op-60" aria-hidden="true" />
    <span class="text-sm">
      <slot />
    </span>
    <div v-if="$slots.action">
      <slot name="action" />
    </div>
  </div>
</template>
