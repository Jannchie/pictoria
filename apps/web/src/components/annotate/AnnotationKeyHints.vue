<script setup lang="ts">
// The key legend in a session's top bar. Key caps are not translated (convention);
// the action words are.
defineProps<{ hints: { keys: string[], label: string }[] }>()
</script>

<template>
  <span class="annotate-key-hints" :aria-label="$t('annotate.keys.title')" role="note">
    <span v-for="(h, i) in hints" :key="i" class="annotate-key-hints__item">
      <template v-for="(k, j) in h.keys" :key="j"><template v-if="j > 0">+</template><kbd>{{ k }}</kbd></template>
      {{ h.label }}
    </span>
  </span>
</template>

<style scoped>
.annotate-key-hints {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.annotate-key-hints kbd {
  display: inline-block;
  padding: 1px 5px;
  margin: 0 1px;
  font-family: var(--p-font-mono);
  font-size: 10px;
  border: 1px solid var(--p-border);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: inherit;
}
</style>
