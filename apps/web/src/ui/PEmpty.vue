<script setup lang="ts">
import PButton from './PButton.vue'

// Centered empty-state primitive: optional icon + a line of text + optional
// action area. No border / background / card — empty states live inline,
// matching the design system's "no nested panels" principle.
//
// The icon is a UnoCSS icon class (e.g. `i-tabler-photo-off`); the text comes
// from the default slot (callers pass their own `$t(...)`). The root element
// carries layout utilities only, so callers can override spacing by passing a
// `class` (e.g. `class="py-4"` in popovers).
//
// Load-failure states: pass `retry` and the action area gets the one standard
// "Retry" button (spinning while `retrying`), instead of every caller building
// its own.
withDefaults(defineProps<{
  icon?: string
  /** Shows the standard Retry button, which calls this. */
  retry?: () => void
  /** A retry is in flight: the Retry button shows its loading state. */
  retrying?: boolean
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
    <div v-if="$slots.action || retry">
      <slot name="action">
        <PButton size="sm" :loading="retrying" @click="retry?.()">
          <i class="i-tabler-refresh" aria-hidden="true" />
          {{ $t('common.retry') }}
        </PButton>
      </slot>
    </div>
  </div>
</template>
