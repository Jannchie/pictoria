<script setup lang="ts">
import { textSearchQuery, useSyncFilterWithUrl } from '@/shared'

useSyncFilterWithUrl()

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
      <WaifuScoreFilter />
    </div>
    <div class="flex gap-2 items-center">
      <PInput
        v-model="textSearchQuery"
        size="sm"
        class="min-w-60"
        placeholder="Describe what you want to see..."
      >
        <template #leftSection>
          <i class="i-tabler-search text-fg-muted" />
        </template>
        <template
          v-if="textSearchQuery"
          #rightSection
        >
          <button
            class="text-fg-muted hover:text-fg"
            @click="clearTextSearch"
          >
            <i class="i-tabler-x text-sm" />
          </button>
        </template>
      </PInput>
      <PostSorter />
    </div>
  </div>
</template>
