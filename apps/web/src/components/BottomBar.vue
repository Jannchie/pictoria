<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { v2GetPostsStats } from '@/api'
import { formatNumber } from '@/locale'
import { bottomBarInfo, leftPaneCollapsed, postFilter, queryKeys, RATING_LEVEL_LABEL_KEYS, RATING_LEVEL_SHORT, rightPaneCollapsed, selectedCount, usePosts } from '@/shared'

const posts = usePosts()
const route = useRoute()

const inGalleryView = computed(() => route.name === 'all' || route.name === 'dir')

const statsQuery = useQuery({
  queryKey: computed(() => queryKeys.postsStats(postFilter.value)),
  queryFn: async () => {
    const resp = await v2GetPostsStats({ body: { ...postFilter.value } })
    return resp.data
  },
  enabled: inGalleryView,
  staleTime: 1000 * 30,
})

const ratingCounts = computed(() => {
  const dist = statsQuery.data.value?.ratingDistribution ?? []
  return [1, 2, 3, 4]
    .map(r => ({
      rating: r,
      short: RATING_LEVEL_SHORT[r - 1],
      fullKey: RATING_LEVEL_LABEL_KEYS[r - 1],
      count: dist.find(d => d.rating === r)?.count ?? 0,
    }))
    .filter(d => d.count > 0)
})

function fmtAvg(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined) {
    return '—'
  }
  return value.toFixed(fractionDigits)
}
</script>

<template>
  <div
    class="text-xs text-fg-muted px-2 border-t border-border-default bg-bg flex shrink-0 gap-4 h-24px items-center"
  >
    <!-- Pane toggles live here rather than in the panes themselves: a pane's
         own header disappears with it, this one never does. -->
    <button
      type="button"
      class="text-fg-subtle rounded flex shrink-0 h-4.5 w-4.5 transition-colors items-center justify-center hover:text-fg hover:bg-surface-1"
      :aria-pressed="!leftPaneCollapsed"
      :title="`${$t('pane.toggleLeft')} (Ctrl+B)`"
      :aria-label="$t('pane.toggleLeft')"
      @click="leftPaneCollapsed = !leftPaneCollapsed"
    >
      <i
        class="h-3.5 w-3.5"
        :class="leftPaneCollapsed ? 'i-tabler-layout-sidebar-left-expand' : 'i-tabler-layout-sidebar-left-collapse'"
        aria-hidden="true"
      />
    </button>
    <template v-if="inGalleryView">
      <span class="flex gap-1 items-center">
        <i class="i-tabler-photo text-fg-subtle" aria-hidden="true" />
        <span class="font-mono tabular-nums">{{ formatNumber(posts.length) }}</span>
        <span class="text-fg-subtle">{{ $t('bottomBar.displayed') }}</span>
      </span>
      <span
        v-if="selectedCount > 0"
        class="text-primary flex gap-1 items-center"
      >
        <i class="i-tabler-checks" aria-hidden="true" />
        <span class="font-mono tabular-nums">{{ formatNumber(selectedCount) }}</span>
        <span>{{ $t('bottomBar.selected') }}</span>
      </span>
      <template v-if="statsQuery.data.value">
        <span class="bg-border-subtle h-3 w-px" aria-hidden="true" />
        <span
          class="flex gap-1 items-center"
          :aria-label="$t('bottomBar.avgScoreAria', { n: statsQuery.data.value.scoredCount })"
        >
          <i class="i-tabler-star text-fg-subtle" aria-hidden="true" />
          <span class="font-mono tabular-nums">{{ fmtAvg(statsQuery.data.value.avgScore) }}</span>
          <span class="text-fg-subtle" aria-hidden="true">·</span>
          <span class="text-fg-subtle font-mono tabular-nums">{{ formatNumber(statsQuery.data.value.scoredCount) }}</span>
        </span>
        <span
          class="flex gap-1 items-center"
          :aria-label="$t('bottomBar.avgWaifuAria', { n: statsQuery.data.value.waifuCount })"
        >
          <i class="i-tabler-trophy text-fg-subtle" aria-hidden="true" />
          <span class="font-mono tabular-nums">{{ fmtAvg(statsQuery.data.value.avgWaifuScore) }}</span>
          <span class="text-fg-subtle" aria-hidden="true">·</span>
          <span class="text-fg-subtle font-mono tabular-nums">{{ formatNumber(statsQuery.data.value.waifuCount) }}</span>
        </span>
        <template v-if="ratingCounts.length > 0">
          <span class="bg-border-subtle h-3 w-px" aria-hidden="true" />
          <span
            v-for="r in ratingCounts"
            :key="r.rating"
            class="flex gap-1 items-center"
            :aria-label="`${$t(r.fullKey)}: ${formatNumber(r.count)}`"
          >
            <span class="text-fg-subtle" aria-hidden="true">{{ r.short }}</span>
            <span class="font-mono tabular-nums">{{ formatNumber(r.count) }}</span>
          </span>
        </template>
      </template>
    </template>
    <template v-else>
      {{ bottomBarInfo }}
    </template>
    <span class="flex-grow" />
    <button
      type="button"
      class="text-fg-subtle rounded flex shrink-0 h-4.5 w-4.5 transition-colors items-center justify-center hover:text-fg hover:bg-surface-1"
      :aria-pressed="!rightPaneCollapsed"
      :title="`${$t('pane.toggleRight')} (Ctrl+Shift+B)`"
      :aria-label="$t('pane.toggleRight')"
      @click="rightPaneCollapsed = !rightPaneCollapsed"
    >
      <i
        class="h-3.5 w-3.5"
        :class="rightPaneCollapsed ? 'i-tabler-layout-sidebar-right-expand' : 'i-tabler-layout-sidebar-right-collapse'"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
