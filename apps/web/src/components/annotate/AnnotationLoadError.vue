<script setup lang="ts">
// A session's empty-screen state after a batch failed to load: the message
// plus a Retry button (the session wires `retry` to its stream's `refill`).
const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div role="alert" class="text-sm text-fg-muted flex flex-col gap-3 items-center">
    {{ $t('annotate.session.loadFailed') }}
    <PButton size="sm" variant="subtle" @click="emit('retry')">
      {{ $t('common.retry') }}
    </PButton>
  </div>
</template>
