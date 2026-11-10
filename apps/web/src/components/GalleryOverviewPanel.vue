<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { formatAverage as fmtAvg, usePostsStatsQuery } from '@/composables/usePostsStatsQuery'
import { formatNumber } from '@/locale'
import {
  currentPostList,
  galleryListFailed,
  postFilter,
  RATING_ICON,
  ratingName,
  ratingVisual,
  SCORE_ICON,
  scorerIcon,
  useCurrentFolder,
} from '@/shared'
import { galleryViewNameKey, isGalleryRoute, isLibraryView } from '@/shared/galleryView'

// Shown in the right pane whenever nothing is selected: a reading of the
// *current view* — its name, how big it is and how its ratings are distributed,
// every rating row doubling as a filter toggle. The active filters are not
// repeated here; the chip row under the filter bar is their one place.

const { t } = useI18n()
const route = useRoute()
const currentFolder = useCurrentFolder()

// Derived from the route table's `meta.view`. A hand-kept list of names
// missed `/`, which has no name — the landing page never fetched stats.
const inGalleryView = computed(() => isGalleryRoute(route))
// The stats endpoint aggregates the filtered *library* (root or a folder).
// /recently, /random and /unrated-artists are other lists over it, so its
// numbers would describe something the grid isn't showing — not shown there.
const inLibraryView = computed(() => isLibraryView(route.meta.view))

const VIEW_ICONS: Record<string, string> = {
  recently: 'i-tabler-clock',
  random: 'i-tabler-arrows-cross',
  unratedArtists: 'i-tabler-user-question',
}

const scopeFolder = computed(() => {
  if (route.meta.view !== 'dir') {
    return
  }
  const folder = currentFolder.value
  if (!folder || folder === '@') {
    return
  }
  return folder.split('/').at(-1) ?? folder
})
const heading = computed(() => scopeFolder.value ?? t(galleryViewNameKey(route.meta.view)))
const headingIcon = computed(() => {
  if (scopeFolder.value) {
    return 'i-tabler-folder'
  }
  return VIEW_ICONS[route.meta.view ?? ''] ?? 'i-tabler-photo'
})

const { stats, failed: statsFailed } = usePostsStatsQuery({ enabled: inLibraryView })

const WAIFU_ICON = scorerIcon('waifu')

// Rating rows, widest bar = the largest bucket (not the total), so the shape
// stays readable when one rating dominates.
const ratingRows = computed(() => {
  const dist = stats.value?.ratingDistribution ?? []
  const rows = [1, 2, 3, 4].map(r => ({
    rating: r,
    ...ratingVisual(r),
    name: ratingName(r, t),
    count: dist.find(d => d.rating === r)?.count ?? 0,
  }))
  const max = Math.max(1, ...rows.map(r => r.count))
  return rows.map(r => ({ ...r, ratio: r.count / max }))
})

const hasRatingData = computed(() => ratingRows.value.some(r => r.count > 0))

function hasRatingFilter(rating: number): boolean {
  return postFilter.value.rating.includes(rating)
}
function toggleRating(rating: number): void {
  const current = postFilter.value.rating
  postFilter.value.rating = current.includes(rating)
    ? current.filter(r => r !== rating)
    : [...current, rating]
}
</script>

<template>
  <!-- Outside the gallery (tags, settings) there is no "current view" to read;
       a bare "All" heading there claimed a scope that didn't exist. -->
  <PScrollArea
    v-if="inGalleryView"
    class="text-xs h-full overflow-x-hidden overflow-y-auto"
  >
    <div class="px-3 flex flex-col">
      <!-- Scope -->
      <div class="pb-3 pt-3 p-divider flex gap-2 items-center">
        <i
          class="text-fg-subtle shrink-0"
          :class="headingIcon"
          aria-hidden="true"
        />
        <h2 class="text-sm text-fg font-medium truncate">
          {{ heading }}
        </h2>
        <span
          v-if="inLibraryView && stats"
          class="text-fg-subtle ml-auto tabular-nums"
        >{{ formatNumber(stats.total) }}</span>
        <!-- Other views: what the grid holds, not the library behind it. -->
        <i18n-t
          v-else-if="!inLibraryView && !galleryListFailed"
          keypath="bottomBar.displayedN"
          tag="span"
          scope="global"
          class="text-fg-subtle ml-auto whitespace-nowrap"
        >
          <template #n>
            <span class="tabular-nums">{{ formatNumber(currentPostList.length) }}</span>
          </template>
        </i18n-t>
      </div>

      <p
        v-if="route.meta.view === 'unratedArtists'"
        class="text-fg-muted py-3 p-divider"
      >
        {{ $t('annotate.unratedArtistsHint') }}
      </p>

      <p
        v-if="inLibraryView && statsFailed"
        class="text-fg-subtle py-3 flex gap-1.5 items-center"
        role="status"
      >
        <i class="i-tabler-alert-circle" aria-hidden="true" />
        {{ $t('bottomBar.statsUnavailable') }}
      </p>

      <!-- Rating distribution — each row toggles that rating's filter. -->
      <section
        v-if="inLibraryView && hasRatingData"
        class="py-3 p-divider"
      >
        <h3 class="p-section-title mb-2">
          <i :class="RATING_ICON" aria-hidden="true" />
          <span>{{ $t('overview.ratingDistribution') }}</span>
        </h3>
        <!-- One grid for all rows (each row is a subgrid) so the label column
             is as wide as the longest level name — "Questionable" no longer
             truncates. -->
        <div class="gap-x-2 gap-y-1 grid grid-cols-[auto_auto_1fr_auto] items-center">
          <button
            v-for="row in ratingRows"
            :key="row.rating"
            type="button"
            class="rating-row px-1.5 py-1 rounded grid col-span-4 transition-colors items-center hover:bg-surface-1"
            :class="{ 'bg-primary/10': hasRatingFilter(row.rating) }"
            :aria-pressed="hasRatingFilter(row.rating)"
            @click="toggleRating(row.rating)"
          >
            <i
              :class="row.icon"
              :style="{ color: row.color }"
              aria-hidden="true"
            />
            <span class="text-fg-muted text-left whitespace-nowrap">{{ row.name }}</span>
            <!-- Bar track: --p-surface-3 is the in-control pedestal case. -->
            <span class="rounded-full bg-surface-3 h-1 min-w-8 overflow-hidden" aria-hidden="true">
              <span
                class="rounded-full h-full block"
                :style="{ width: `${row.ratio * 100}%`, backgroundColor: row.color }"
              />
            </span>
            <span class="text-fg-muted text-right tabular-nums">{{ formatNumber(row.count) }}</span>
          </button>
        </div>
      </section>

      <!-- Aggregate scores -->
      <section
        v-if="inLibraryView && stats"
        class="py-3 p-divider"
      >
        <h3 class="p-section-title mb-2">
          <i class="i-tabler-chart-bar" aria-hidden="true" />
          <span>{{ $t('overview.averages') }}</span>
        </h3>
        <div class="gap-x-3 gap-y-1.5 grid grid-cols-[auto_1fr_auto] items-center">
          <i :class="SCORE_ICON" class="text-fg-subtle" aria-hidden="true" />
          <span class="text-fg-muted">{{ $t('post.scoreLabel') }}</span>
          <span class="tabular-nums">
            {{ fmtAvg(stats.avgScore) }}
            <span class="text-fg-subtle">· {{ formatNumber(stats.scoredCount) }}</span>
          </span>
          <i :class="WAIFU_ICON" class="text-fg-subtle" aria-hidden="true" />
          <span class="text-fg-muted">{{ $t('post.waifuLabel') }}</span>
          <span class="tabular-nums">
            {{ fmtAvg(stats.avgWaifuScore) }}
            <span class="text-fg-subtle">· {{ formatNumber(stats.waifuCount) }}</span>
          </span>
        </div>
      </section>
    </div>
  </PScrollArea>
</template>

<style scoped>
.rating-row {
  grid-template-columns: subgrid;
}
</style>
