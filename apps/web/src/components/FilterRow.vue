<script setup lang="ts">
import type { FilterChip } from '@/composables/useActiveFilters'
import { nextTick, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useActiveFilters } from '@/composables/useActiveFilters'
import { announce, openCommandPalette, textSearchQuery, waterfallRowCount } from '@/shared'
import { shortcuts } from '@/shared/shortcuts'
import { focusElement } from '@/utils/focus'
import { formatShortcut, isMac } from '@/utils/keyboard'

const { t } = useI18n()

// The individual facet buttons each know only their own state, so this row also
// carries the summary: what's applied right now, and one way to clear it.
const { chips, isFiltered, clearAll } = useActiveFilters()

// The palette's global hotkey (registered by the palette itself) — shown as a
// hint here, and exposed via aria-keyshortcuts.
const paletteShortcut = formatShortcut(shortcuts.global.openPalette.keys[0])
const paletteAriaShortcut = isMac ? 'Meta+K' : 'Control+K'

const chipList = useTemplateRef<HTMLElement>('chipList')
const searchButton = useTemplateRef<HTMLElement>('searchButton')

// Removing a chip unmounts the focused button; keep focus in the chip row
// (the chip that slid into its place, else the one before it, else "Clear
// all"), and fall back to the search button once the row disappears.
async function removeChip(chip: FilterChip, index: number) {
  chip.remove()
  announce(t('filter.filterRemoved', { label: chip.label }))
  await nextTick()
  const buttons = [...chipList.value?.querySelectorAll<HTMLElement>('[data-chip]') ?? []]
  const next = buttons[Math.min(index, buttons.length - 1)]
  if (!focusElement(next)) {
    focusElement(chipList.value?.querySelector<HTMLElement>('[data-clear-all]')) || focusElement(searchButton.value)
  }
}

async function onClearAll() {
  clearAll()
  announce(t('filter.filtersCleared'))
  await nextTick()
  focusElement(searchButton.value)
}
</script>

<template>
  <div class="px-3 py-2 border-b border-border-subtle flex flex-col gap-1.5 w-full">
    <div class="flex flex-wrap gap-x-4 gap-y-1.5 w-full items-center justify-between">
      <!-- Facets are ghost buttons at rest and tint only when they hold a
           selection: the row should read as a line of labels, not a row of
           boxes, so the active narrowing is the only thing that stands out. -->
      <div class="flex flex-wrap gap-1 items-center">
        <ScoreFilter />
        <RatingFilter />
        <ExtensionFilter />
        <TagFilter />
        <WaifuScoreFilter />
        <SilvaScoreFilter />
        <SilvaLunaScoreFilter />
      </div>
      <!-- Right cluster, in two groups: finding things (search + sort), then
           how densely they are laid out. The divider keeps the density slider
           from reading as a third search control. -->
      <div class="ml-auto flex gap-2 items-center">
        <!-- Search is no longer a box in the corner: it's the palette, which is
             also where the filter expression and the commands live. -->
        <button
          ref="searchButton"
          type="button"
          class="text-sm text-fg-muted px-2 rounded-md flex gap-2 h-7 min-w-60 transition-colors items-center hover:text-fg hover:bg-surface-1"
          :aria-label="$t('command.title')"
          :aria-keyshortcuts="paletteAriaShortcut"
          @click="openCommandPalette()"
        >
          <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
          <span class="text-left flex-grow truncate" :class="{ 'text-fg': textSearchQuery }">
            {{ textSearchQuery || $t('filter.semanticPlaceholder') }}
          </span>
          <kbd class="text-2xs text-fg-subtle leading-none font-mono px-1 py-0.5 border border-border-subtle rounded-xs shrink-0" aria-hidden="true">{{ paletteShortcut }}</kbd>
        </button>
        <PostSorter />
        <div
          class="bg-border-subtle shrink-0 h-4 w-px"
          aria-hidden="true"
        />
        <!-- Grid density: the same value Ctrl+wheel drives (see Home.vue). -->
        <div
          class="text-fg-subtle flex gap-1.5 w-36 items-center"
          :title="$t('gallery.columnsValue', { n: waterfallRowCount })"
        >
          <i class="i-tabler-grid-dots text-sm shrink-0" aria-hidden="true" />
          <PSlider
            v-model="waterfallRowCount"
            size="sm"
            :min="1"
            :max="16"
            :min-width="0"
            :tick-num="0"
            reverse
            :aria-label="$t('gallery.columnsAria')"
            :aria-valuetext="$t('gallery.columnsValue', { n: waterfallRowCount })"
          />
        </div>
      </div>
    </div>

    <!-- Active-filter chips: the whole narrowing, visible and individually
         removable. Hidden entirely when nothing is applied so the row keeps
         its original height in the common case. -->
    <div
      v-if="isFiltered"
      ref="chipList"
      role="group"
      :aria-label="$t('filter.activeFilters')"
      class="pb-0.5 flex flex-wrap gap-1 items-center"
    >
      <button
        v-for="(chip, i) in chips"
        :key="chip.id"
        type="button"
        data-chip
        class="text-xs text-primary px-1.5 py-0.5 border border-primary/20 rounded-sm bg-primary/10 flex gap-1 max-w-60 transition-colors items-center hover:border-primary/35 hover:bg-primary/18"
        :title="$t('overview.removeFilter', { label: chip.label })"
        :aria-label="$t('overview.removeFilter', { label: chip.label })"
        @click="removeChip(chip, i)"
      >
        <i :class="chip.icon" class="shrink-0" aria-hidden="true" />
        <span class="truncate">{{ chip.label }}</span>
        <i class="i-tabler-x op-60 shrink-0" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-clear-all
        class="text-xs text-fg-subtle px-1.5 py-0.5 rounded-sm transition-colors hover:text-fg hover:bg-surface-1"
        @click="onClearAll()"
      >
        {{ $t('overview.clearAll') }}
      </button>
    </div>
  </div>
</template>
