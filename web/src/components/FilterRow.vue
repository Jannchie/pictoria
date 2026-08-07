<script setup lang="ts">
import { useActiveFilters } from '@/composables/useActiveFilters'
import { openCommandPalette, textSearchQuery } from '@/shared'

// The individual facet buttons each know only their own state, so this row also
// carries the summary: what's applied right now, and one way to clear it.
const { chips, isFiltered, clearAll } = useActiveFilters()
</script>

<template>
  <div class="px-2 py-2 border-b border-border-default flex flex-col gap-2 w-full">
    <div class="flex gap-2 w-full items-center justify-between">
      <div class="flex gap-2">
        <ScoreFilter />
        <RatingFilter />
        <ExtensionFilter />
        <TagFilter />
        <WaifuScoreFilter />
        <SilvaScoreFilter />
      </div>
      <div class="flex gap-2 items-center">
        <!-- Search is no longer a box in the corner: it's the palette, which is
             also where the filter expression and the commands live. -->
        <button
          type="button"
          class="text-sm text-fg-muted px-2.5 border border-border-subtle rounded-md bg-surface flex gap-2 h-7 min-w-60 transition-colors items-center hover:text-fg hover:border-border-default"
          :aria-label="$t('command.title')"
          @click="openCommandPalette()"
        >
          <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
          <span class="text-left flex-grow truncate">
            {{ textSearchQuery || $t('filter.semanticPlaceholder') }}
          </span>
          <kbd class="text-[10px] text-fg-subtle font-mono px-1.5 py-0.5 border border-border-subtle rounded shrink-0">Ctrl K</kbd>
        </button>
        <PostSorter />
      </div>
    </div>

    <!-- Active-filter chips: the whole narrowing, visible and individually
         removable. Hidden entirely when nothing is applied so the row keeps
         its original height in the common case. -->
    <div
      v-if="isFiltered"
      class="flex flex-wrap gap-1.5 items-center"
    >
      <button
        v-for="chip in chips"
        :key="chip.id"
        type="button"
        class="text-[11px] text-fg-muted px-1.5 py-0.5 border border-border-subtle rounded flex gap-1 max-w-60 transition-colors items-center hover:text-fg hover:border-border-strong"
        :title="$t('overview.removeFilter', { label: chip.label })"
        @click="chip.remove()"
      >
        <i :class="chip.icon" class="shrink-0" aria-hidden="true" />
        <span class="truncate">{{ chip.label }}</span>
        <i class="i-tabler-x op-60 shrink-0" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="text-[11px] text-fg-subtle px-1.5 py-0.5 rounded transition-colors hover:text-fg hover:bg-surface-1"
        @click="clearAll()"
      >
        {{ $t('overview.clearAll') }}
      </button>
    </div>
  </div>
</template>
