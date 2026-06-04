<script setup lang="ts">
import { textSearchQuery } from '@/shared'

function clearTextSearch() {
  textSearchQuery.value = ''
}
</script>

<template>
  <div class="px-2 py-2 border-b border-border-default flex gap-2 w-full items-center justify-between">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
      <TagFilter />
      <WaifuScoreFilter />
      <SilvaScoreFilter />
    </div>
    <div class="flex gap-2 items-center">
      <PInput
        v-model="textSearchQuery"
        size="sm"
        class="min-w-60"
        placeholder="Describe what you want to see…"
        aria-label="Semantic search"
      >
        <template #leftSection>
          <i class="i-tabler-search text-fg-muted" aria-hidden="true" />
        </template>
        <template
          v-if="textSearchQuery"
          #rightSection
        >
          <button
            type="button"
            aria-label="Clear search"
            class="text-fg-muted rounded hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            @click="clearTextSearch"
          >
            <i class="i-tabler-x text-sm" aria-hidden="true" />
          </button>
        </template>
      </PInput>
      <PostSorter />
    </div>
  </div>
</template>
