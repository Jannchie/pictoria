<script setup lang="ts">
import { PKbd } from '@/ui'

// The key legend in a session's top bar. Key caps are not translated (convention);
// the action words are.
defineProps<{ hints: { keys: string[], label: string }[] }>()
</script>

<template>
  <span class="annotate-key-hints" :aria-label="$t('annotate.keys.title')" role="note">
    <span v-for="(h, i) in hints" :key="i" class="annotate-key-hints__item">
      <template v-for="(k, j) in h.keys" :key="j"><template v-if="j > 0">+</template><PKbd>{{ k }}</PKbd></template>
      {{ h.label }}
    </span>
  </span>
</template>

<style scoped>
.annotate-key-hints {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px 8px;
}
</style>
