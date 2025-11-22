<script setup lang="ts">
import { TextField } from '@roku-ui/vue'
import { textSearchQuery, useSyncFilterWithUrl } from '@/shared'

// Activate URL synchronization for all filter components
useSyncFilterWithUrl()

function clearTextSearch() {
  textSearchQuery.value = ''
}
</script>

<template>
  <div class="border-base px-1 pb-1 border-b flex gap-2 w-full items-center justify-between">
    <div class="flex gap-2">
      <ScoreFilter />
      <RatingFilter />
      <ExtensionFilter />
      <WaifuScoreFilter />
    </div>
    <div class="flex gap-2 items-center">
      <TextField
        v-model="textSearchQuery"
        size="sm"
        class="min-w-60"
        placeholder="Describe what you want to see..."
      >
        <template #leftSection>
          <i class="i-tabler-search text-dimmed" />
        </template>
        <template
          v-if="textSearchQuery"
          #rightSection
        >
          <button
            class="text-dimmed hover:text-highlight"
            @click="clearTextSearch"
          >
            <i class="i-tabler-x text-sm" />
          </button>
        </template>
      </TextField>
      <PostSorter />
    </div>
  </div>
</template>
