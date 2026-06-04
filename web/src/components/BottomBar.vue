<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { v2GetPostsStats } from '@/api'
import { formatNumber } from '@/locale'
import { bottomBarInfo, postFilter, queryKeys, selectedPostIdSet, usePosts } from '@/shared'

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

const RATING_META: Record<number, { short: string, fullKey: string }> = {
  1: { short: 'G', fullKey: 'rating.general' },
  2: { short: 'S', fullKey: 'rating.sensitive' },
  3: { short: 'Q', fullKey: 'rating.questionable' },
  4: { short: 'E', fullKey: 'rating.explicit' },
}

const ratingCounts = computed(() => {
  const dist = statsQuery.data.value?.ratingDistribution ?? []
  return [1, 2, 3, 4]
    .map(r => ({ rating: r, ...RATING_META[r], count: dist.find(d => d.rating === r)?.count ?? 0 }))
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
    class="text-xs text-fg-muted px-3 border-t border-border-default bg-bg flex shrink-0 gap-4 h-24px items-center"
  >
    <template v-if="inGalleryView">
      <span class="flex gap-1 items-center">
        <i class="i-tabler-photo text-fg-subtle" aria-hidden="true" />
        <span class="font-mono tabular-nums">{{ formatNumber(posts.length) }}</span>
        <span class="text-fg-subtle">{{ $t('bottomBar.displayed') }}</span>
      </span>
      <span
        v-if="selectedPostIdSet.size > 0"
        class="text-primary flex gap-1 items-center"
      >
        <i class="i-tabler-checks" aria-hidden="true" />
        <span class="font-mono tabular-nums">{{ formatNumber(selectedPostIdSet.size) }}</span>
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
  </div>
</template>
