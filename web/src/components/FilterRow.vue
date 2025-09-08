<script setup lang="ts">
import { useSyncFilterWithUrl } from '@/shared'

// Activate URL synchronization for all filter components
useSyncFilterWithUrl()
</script>

<template>
  <div class="px-1 pb-1 border-b border-surface flex gap-2 w-full justify-between">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
      <WaifuScoreFilter />
    </div>
    <div>
      <PostSorter />
    </div>
  </div>
</template>
