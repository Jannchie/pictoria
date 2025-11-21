<script setup lang="ts">
import { textSearchQuery, useSyncFilterWithUrl } from '@/shared'

// Activate URL synchronization for all filter components
useSyncFilterWithUrl()

function clearTextSearch() {
  textSearchQuery.value = ''
}
</script>

<template>
  <div class="px-1 pb-1 border-b border-surface flex gap-2 w-full items-center justify-between">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
      <WaifuScoreFilter />
    </div>
    <div class="flex gap-2 items-center">
      <div class="text-sm relative">
        <i class="i-tabler-search text-surface-dimmed left-3 top-1/2 absolute -translate-y-1/2" />
        <input
          v-model="textSearchQuery"
          type="text"
          class="text-surface-high py-1 pl-9 pr-8 border border-surface rounded bg-transparent min-w-60 transition-colors focus:(outline-none border-primary)"
          placeholder="Describe what you want to see..."
        >
        <button
          v-if="textSearchQuery"
          class="hover:text-surface-high text-surface-dimmed right-2 top-1/2 absolute -translate-y-1/2"
          @click="clearTextSearch"
        >
          <i class="i-tabler-x text-sm" />
        </button>
      </div>
      <PostSorter />
    </div>
  </div>
</template>
