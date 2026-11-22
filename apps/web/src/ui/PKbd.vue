<script setup lang="ts">
// A key cap. Two looks exist in the app, and each is reproduced exactly:
//
// - `raised` (default): the keycap with a 2px bottom edge, used in key legends
//   and inline hints. `size="md"` is the slightly larger cap of the annotate
//   launcher's start hint (11px, wider padding, no side margin). Colour is
//   inherited, so a cap reads in whatever tone its sentence is in.
// - `flat`: the small hairline cap that sits inside a button (search field,
//   undo snackbar). Always subtle-coloured; `size` does not apply.
//
// Keycap text is one of the places monospace is genuinely needed (it names a
// key, character by character). Pass `aria-hidden="true"` when the key is
// already announced elsewhere (aria-keyshortcuts, a label) — it falls through.
withDefaults(defineProps<{
  variant?: 'raised' | 'flat'
  /** Raised caps only. */
  size?: 'sm' | 'md'
}>(), {
  variant: 'raised',
  size: 'sm',
})
</script>

<template>
  <kbd
    v-if="variant === 'flat'"
    class="text-2xs text-fg-subtle leading-none font-mono px-1 py-0.5 border border-border-subtle rounded-xs"
  ><slot /></kbd>
  <kbd
    v-else
    class="p-kbd"
    :class="{ 'p-kbd--md': size === 'md' }"
  ><slot /></kbd>
</template>

<style scoped>
.p-kbd {
  display: inline-block;
  padding: 1px 5px;
  margin: 0 1px;
  font-family: var(--p-font-mono);
  font-size: var(--p-text-2xs);
  border: 1px solid var(--p-border);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
}
.p-kbd--md {
  padding: 1px 6px;
  margin: 0;
  font-size: 11px;
}
</style>
