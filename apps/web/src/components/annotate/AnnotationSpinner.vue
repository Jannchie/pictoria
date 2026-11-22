<script setup lang="ts">
// The small ring spinner the annotation sessions put beside "Loading…" /
// "Submitting…". Decorative: the text next to it is what gets announced.
</script>

<template>
  <span class="annotation-spinner" aria-hidden="true" />
</template>

<style scoped>
.annotation-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--p-border);
  border-top-color: var(--p-primary);
  border-radius: 50%;
  animation: annotation-spin 0.7s linear infinite;
}
@keyframes annotation-spin {
  to { transform: rotate(360deg); }
}
</style>
