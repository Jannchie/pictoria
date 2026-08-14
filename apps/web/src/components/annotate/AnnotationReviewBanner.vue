<script setup lang="ts">
// The "you are editing a submitted record" strip that replaces the question banner in
// both annotation sessions. It lived twice, as 6 lines of markup and 20 lines of
// byte-identical scoped CSS differing only in class prefix — so a change to the
// treatment reached one session and not the other, visible only if you ran both.
defineProps<{ verdict: string }>()
defineEmits<{ exit: [] }>()
</script>

<template>
  <div class="review-banner text-sm text-fg font-medium px-4 py-2 text-center p-divider shrink-0">
    {{ $t('annotate.history.reviewing') }}
    <span class="text-xs text-fg-muted ml-2">{{ $t('annotate.history.wasVerdict', { verdict }) }}</span>
    <PButton size="xs" variant="subtle" class="ml-3" @click="$emit('exit')">
      <kbd class="review-banner__kbd">Esc</kbd> {{ $t('annotate.history.exitReview') }}
    </PButton>
  </div>
</template>

<style scoped>
.review-banner {
  background: rgb(var(--p-primary-rgb) / 0.1);
}
.review-banner__kbd {
  margin-right: 4px;
  padding: 0 4px;
  font-family: var(--p-font-mono);
  font-size: 10px;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-xs);
}
</style>
