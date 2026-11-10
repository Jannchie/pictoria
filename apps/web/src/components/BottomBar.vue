<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { formatAverage as fmtAvg, usePostsStatsQuery } from '@/composables/usePostsStatsQuery'
import { formatNumber } from '@/locale'
import { bottomBarInfo, currentPostList, galleryListFailed, RATING_LEVEL_SHORT_KEYS, ratingName, SCORE_ICON, scorerIcon, selectedCount } from '@/shared'
import { isLibraryView } from '@/shared/galleryView'
import { isLeftCollapsed, isRightCollapsed, routeHasRightPane, toggleLeftPane, toggleRightPane } from '@/shared/paneLayout'
import { shortcuts } from '@/shared/shortcuts'
import { formatShortcut } from '@/utils/keyboard'

const { t } = useI18n()
const route = useRoute()

const inLibraryView = computed(() => isLibraryView(route.meta.view))

const WAIFU_ICON = scorerIcon('waifu')
const leftShortcut = formatShortcut(shortcuts.global.toggleLeft.keys[0])
const rightShortcut = formatShortcut(shortcuts.global.toggleRight.keys[0])

const { stats, failed: statsFailed } = usePostsStatsQuery({ enabled: inLibraryView, keepPrevious: true })

const ratingCounts = computed(() => {
  const dist = stats.value?.ratingDistribution ?? []
  return [1, 2, 3, 4]
    .map(r => ({
      rating: r,
      shortKey: RATING_LEVEL_SHORT_KEYS[r - 1],
      name: ratingName(r, t),
      count: dist.find(d => d.rating === r)?.count ?? 0,
    }))
    .filter(d => d.count > 0)
})
</script>

<template>
  <div
    class="text-xs text-fg-muted px-2 border-t border-border-subtle bg-bg flex shrink-0 gap-4 h-24px items-center overflow-hidden"
  >
    <!-- Pane toggles live here rather than in the panes themselves: a pane's
         own header disappears with it, this one never does. -->
    <button
      type="button"
      class="text-fg-subtle rounded flex shrink-0 h-4.5 w-4.5 transition-colors items-center justify-center hover:text-fg hover:bg-surface-1"
      :aria-pressed="!isLeftCollapsed"
      :title="`${$t('pane.toggleLeft')} (${leftShortcut})`"
      :aria-label="$t('pane.toggleLeft')"
      @click="toggleLeftPane()"
    >
      <i
        class="h-3.5 w-3.5"
        :class="isLeftCollapsed ? 'i-tabler-layout-sidebar-left-expand' : 'i-tabler-layout-sidebar-left-collapse'"
        aria-hidden="true"
      />
    </button>
    <template v-if="inLibraryView">
      <span
        v-if="galleryListFailed"
        class="text-danger flex shrink-0 gap-1 items-center"
      >
        <i class="i-tabler-alert-circle" aria-hidden="true" />
        <span>{{ $t('bottomBar.listFailed') }}</span>
      </span>
      <!-- The list MainSection publishes, so a text search counts its results. -->
      <i18n-t
        v-else
        keypath="bottomBar.displayedN"
        tag="span"
        scope="global"
        class="text-fg-subtle flex shrink-0 gap-1 whitespace-nowrap items-center"
      >
        <template #n>
          <span class="text-fg-muted tabular-nums">{{ formatNumber(currentPostList.length) }}</span>
        </template>
      </i18n-t>
      <i18n-t
        v-if="selectedCount > 0"
        keypath="bottomBar.selectedN"
        tag="span"
        scope="global"
        class="text-primary flex shrink-0 gap-1 whitespace-nowrap items-center"
      >
        <template #n>
          <span class="tabular-nums">{{ formatNumber(selectedCount) }}</span>
        </template>
      </i18n-t>
      <span
        v-if="statsFailed"
        class="text-fg-subtle shrink-0"
      >{{ $t('bottomBar.statsUnavailable') }}</span>
      <template v-else-if="stats">
        <span class="bg-border-subtle shrink-0 h-3 w-px" aria-hidden="true" />
        <span
          class="flex shrink-0 gap-1 items-center"
          :aria-label="$t('bottomBar.avgScoreAria', { n: stats.scoredCount })"
        >
          <i :class="SCORE_ICON" class="text-fg-subtle" aria-hidden="true" />
          <span class="tabular-nums">{{ fmtAvg(stats.avgScore) }}</span>
          <span class="text-fg-subtle" aria-hidden="true">·</span>
          <span class="text-fg-subtle tabular-nums">{{ formatNumber(stats.scoredCount) }}</span>
        </span>
        <span
          class="flex shrink-0 gap-1 items-center"
          :aria-label="$t('bottomBar.avgWaifuAria', { n: stats.waifuCount })"
        >
          <i :class="WAIFU_ICON" class="text-fg-subtle" aria-hidden="true" />
          <span class="tabular-nums">{{ fmtAvg(stats.avgWaifuScore) }}</span>
          <span class="text-fg-subtle" aria-hidden="true">·</span>
          <span class="text-fg-subtle tabular-nums">{{ formatNumber(stats.waifuCount) }}</span>
        </span>
        <template v-if="ratingCounts.length > 0">
          <span class="bg-border-subtle shrink-0 h-3 w-px" aria-hidden="true" />
          <span
            v-for="r in ratingCounts"
            :key="r.rating"
            class="flex shrink-0 gap-1 items-center"
            :aria-label="`${r.name}: ${formatNumber(r.count)}`"
          >
            <span class="text-fg-subtle" aria-hidden="true">{{ $t(r.shortKey) }}</span>
            <span class="tabular-nums">{{ formatNumber(r.count) }}</span>
          </span>
        </template>
      </template>
    </template>
    <span v-else class="truncate">
      {{ bottomBarInfo }}
    </span>
    <span class="flex-grow" />
    <button
      v-if="routeHasRightPane"
      type="button"
      class="text-fg-subtle rounded flex shrink-0 h-4.5 w-4.5 transition-colors items-center justify-center hover:text-fg hover:bg-surface-1"
      :aria-pressed="!isRightCollapsed"
      :title="`${$t('pane.toggleRight')} (${rightShortcut})`"
      :aria-label="$t('pane.toggleRight')"
      @click="toggleRightPane()"
    >
      <i
        class="h-3.5 w-3.5"
        :class="isRightCollapsed ? 'i-tabler-layout-sidebar-right-expand' : 'i-tabler-layout-sidebar-right-collapse'"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
