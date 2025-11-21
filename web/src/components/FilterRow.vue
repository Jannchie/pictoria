<script setup lang="ts">
import { textSearchQuery, useSyncFilterWithUrl } from '@/shared'

// Activate URL synchronization for all filter components
useSyncFilterWithUrl()

function clearTextSearch() {
  textSearchQuery.value = ''
}
</script>

<template>
  <div class="px-1 pb-1 border-b border-surface flex gap-2 w-full justify-between items-center">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
      <WaifuScoreFilter />
    </div>
    <div class="flex items-center gap-2">
      <div class="relative text-sm">
        <i class="i-tabler-search absolute left-3 top-1/2 -translate-y-1/2 text-surface-dimmed" />
        <input
          v-model="textSearchQuery"
          type="text"
          class="pl-9 pr-8 py-1 rounded border border-surface bg-transparent text-surface-high min-w-60 focus:(outline-none border-primary) transition-colors"
          placeholder="Describe what you want to see..."
        >
        <button
          v-if="textSearchQuery"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-surface-dimmed hover:text-surface-high"
          @click="clearTextSearch"
        >
          <i class="i-tabler-x text-sm" />
        </button>
      </div>
      <PostSorter />
    </div>
  </div>
</template>
