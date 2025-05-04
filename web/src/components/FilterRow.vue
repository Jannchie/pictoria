<script setup lang="ts">
import { useSyncFilterWithUrl } from '@/shared'

// Activate URL synchronization for all filter components
useSyncFilterWithUrl()
</script>

<template>
  <div class="w-full flex justify-between gap-2 border-b border-surface px-1 pb-1">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
    </div>
    <div>
      <PostSorter />
    </div>
  </div>
</template>
