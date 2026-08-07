<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { v2GetPostsStats } from '@/api'
import { useActiveFilters } from '@/composables/useActiveFilters'
import { formatNumber } from '@/locale'
import {
  postFilter,
  queryKeys,
  RATING_LEVEL_COLORS,
  RATING_LEVEL_ICONS,
  RATING_LEVEL_LABEL_KEYS,
  useCurrentFolder,
} from '@/shared'

// Shown in the right pane whenever nothing is selected. The old empty state was
// a "pick a thumbnail" placeholder — a quarter of the viewport spent saying
// nothing. This turns the same space into the reading of the *current view*:
// what's filtering it, how big it is, and how its ratings are distributed —
// with every row doubling as a filter toggle.

const route = useRoute()
const currentFolder = useCurrentFolder()
const { chips, isFiltered, clearAll } = useActiveFilters()

const inGalleryView = computed(() => route.name === 'all' || route.name === 'dir' || route.path === '/recently' || route.path === '/random')

const scopeLabel = computed(() => {
  const folder = currentFolder.value
  if (!folder || folder === '@') {
    return
  }
  return folder.split('/').at(-1) ?? folder
})

const statsQuery = useQuery({
  queryKey: computed(() => queryKeys.postsStats(postFilter.value)),
  queryFn: async () => {
    const resp = await v2GetPostsStats({ body: { ...postFilter.value } })
    return resp.data
  },
  enabled: inGalleryView,
  staleTime: 1000 * 30,
})

const stats = computed(() => statsQuery.data.value)

// Rating rows, widest bar = the largest bucket (not the total), so the shape
// stays readable when one rating dominates.
const ratingRows = computed(() => {
  const dist = stats.value?.ratingDistribution ?? []
  const rows = [1, 2, 3, 4].map(r => ({
    rating: r,
    icon: RATING_LEVEL_ICONS[r - 1],
    color: RATING_LEVEL_COLORS[r - 1],
    labelKey: RATING_LEVEL_LABEL_KEYS[r - 1],
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

function fmtAvg(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2)
}
</script>

<template>
  <PScrollArea class="text-xs h-full overflow-x-hidden overflow-y-auto">
    <div class="px-3 flex flex-col">
      <!-- Scope -->
      <div class="pb-3 pt-3 p-divider flex gap-2 items-center">
        <i
          class="text-fg-subtle shrink-0"
          :class="scopeLabel ? 'i-tabler-folder' : 'i-tabler-photo'"
          aria-hidden="true"
        />
        <span class="text-sm text-fg font-medium truncate">
          {{ scopeLabel ?? $t('nav.all') }}
        </span>
        <span
          v-if="stats"
          class="text-fg-subtle font-mono ml-auto tabular-nums"
        >{{ formatNumber(stats.total) }}</span>
      </div>

      <!-- Active filters: the one place the whole narrowing is visible. -->
      <section
        v-if="isFiltered"
        class="py-3 p-divider"
      >
        <div class="mb-2 flex items-center justify-between">
          <div class="text-[11px] text-fg-subtle tracking-wider font-semibold flex gap-1.5 uppercase items-center">
            <i class="i-tabler-filter" aria-hidden="true" />
            <span>{{ $t('overview.activeFilters') }}</span>
          </div>
          <PButton
            size="xs"
            variant="subtle"
            class="-my-1.5"
            @click="clearAll"
          >
            {{ $t('overview.clearAll') }}
          </PButton>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="chip in chips"
            :key="chip.id"
            type="button"
            class="text-[11px] text-fg-muted px-1.5 py-0.5 border border-border-subtle rounded flex gap-1 max-w-full transition-colors items-center hover:text-fg hover:border-border-strong"
            :title="$t('overview.removeFilter', { label: chip.label })"
            @click="chip.remove()"
          >
            <i :class="chip.icon" class="shrink-0" aria-hidden="true" />
            <span class="truncate">{{ chip.label }}</span>
            <i class="i-tabler-x op-60 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </section>

      <!-- Rating distribution — each row toggles that rating's filter. -->
      <section
        v-if="hasRatingData"
        class="py-3 p-divider"
      >
        <div class="text-[11px] text-fg-subtle tracking-wider font-semibold mb-2 flex gap-1.5 uppercase items-center">
          <i class="i-tabler-thumb-up" aria-hidden="true" />
          <span>{{ $t('overview.ratingDistribution') }}</span>
        </div>
        <div class="flex flex-col gap-1">
          <button
            v-for="row in ratingRows"
            :key="row.rating"
            type="button"
            class="px-1.5 py-1 rounded flex gap-2 w-full transition-colors items-center hover:bg-surface-1"
            :class="{ 'bg-primary/10': hasRatingFilter(row.rating) }"
            :aria-pressed="hasRatingFilter(row.rating)"
            @click="toggleRating(row.rating)"
          >
            <i
              :class="row.icon"
              :style="{ color: row.color }"
              class="shrink-0"
              aria-hidden="true"
            />
            <span class="text-fg-muted text-left shrink-0 w-14 truncate">{{ $t(row.labelKey) }}</span>
            <!-- Bar track: --p-surface-3 is the in-control pedestal case. -->
            <span class="rounded-full bg-surface-3 flex-grow h-1.5 overflow-hidden">
              <span
                class="rounded-full h-full block"
                :style="{ width: `${row.ratio * 100}%`, backgroundColor: row.color }"
              />
            </span>
            <span class="text-fg-muted font-mono shrink-0 tabular-nums">{{ formatNumber(row.count) }}</span>
          </button>
        </div>
      </section>

      <!-- Aggregate scores -->
      <section
        v-if="stats"
        class="py-3 p-divider"
      >
        <div class="text-[11px] text-fg-subtle tracking-wider font-semibold mb-2 flex gap-1.5 uppercase items-center">
          <i class="i-tabler-chart-bar" aria-hidden="true" />
          <span>{{ $t('overview.averages') }}</span>
        </div>
        <div class="gap-x-3 gap-y-1.5 grid grid-cols-[auto_1fr_auto] items-center">
          <i class="i-tabler-star text-fg-subtle" aria-hidden="true" />
          <span class="text-fg-muted">{{ $t('post.scoreLabel') }}</span>
          <span class="font-mono tabular-nums">
            {{ fmtAvg(stats.avgScore) }}
            <span class="text-fg-subtle">· {{ formatNumber(stats.scoredCount) }}</span>
          </span>
          <i class="i-tabler-trophy text-fg-subtle" aria-hidden="true" />
          <span class="text-fg-muted">{{ $t('post.waifuLabel') }}</span>
          <span class="font-mono tabular-nums">
            {{ fmtAvg(stats.avgWaifuScore) }}
            <span class="text-fg-subtle">· {{ formatNumber(stats.waifuCount) }}</span>
          </span>
        </div>
      </section>

      <!-- Hint stays last: informative, not the headline. -->
      <div class="text-fg-subtle py-3 text-balance">
        {{ $t('rightPanel.emptyHint') }}
      </div>
    </div>
  </PScrollArea>
</template>
