<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { v2GetPostsStats } from '@/api'
import { bottomBarInfo, postFilter, selectedPostIdSet, usePosts } from '@/shared'

const posts = usePosts()
const route = useRoute()

const inGalleryView = computed(() => route.name === 'all' || route.name === 'dir')

const statsQuery = useQuery({
  queryKey: computed(() => ['posts', 'stats', postFilter.value]),
  queryFn: async () => {
    const resp = await v2GetPostsStats({ body: { ...postFilter.value } })
    return resp.data
  },
  enabled: inGalleryView,
  staleTime: 1000 * 30,
})

const RATING_META: Record<number, { short: string, full: string }> = {
  1: { short: 'G', full: 'General' },
  2: { short: 'S', full: 'Sensitive' },
  3: { short: 'Q', full: 'Questionable' },
  4: { short: 'E', full: 'Explicit' },
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

const numberFormat = new Intl.NumberFormat('en-US')
</script>

<template>
  <div
    class="h-24px flex shrink-0 items-center gap-4 border-t border-border-default bg-bg px-3 text-xs text-fg-muted"
  >
    <template v-if="inGalleryView">
      <span class="flex items-center gap-1">
        <i class="i-tabler-photo text-fg-subtle" />
        <span class="font-mono tabular-nums">{{ numberFormat.format(posts.length) }}</span>
        <span class="text-fg-subtle">displayed</span>
      </span>
      <span
        v-if="selectedPostIdSet.size > 0"
        class="flex items-center gap-1 text-primary"
      >
        <i class="i-tabler-checks" />
        <span class="font-mono tabular-nums">{{ numberFormat.format(selectedPostIdSet.size) }}</span>
        <span>selected</span>
      </span>
      <template v-if="statsQuery.data.value">
        <span class="h-3 w-px bg-border-subtle" />
        <span
          class="flex items-center gap-1"
          :title="`Average human score across ${statsQuery.data.value.scoredCount} scored posts`"
        >
          <i class="i-tabler-star text-fg-subtle" />
          <span class="font-mono tabular-nums">{{ fmtAvg(statsQuery.data.value.avgScore) }}</span>
          <span class="text-fg-subtle">·</span>
          <span class="text-fg-subtle font-mono tabular-nums">{{ numberFormat.format(statsQuery.data.value.scoredCount) }}</span>
        </span>
        <span
          class="flex items-center gap-1"
          :title="`Average waifu score across ${statsQuery.data.value.waifuCount} scored posts`"
        >
          <i class="i-tabler-trophy text-fg-subtle" />
          <span class="font-mono tabular-nums">{{ fmtAvg(statsQuery.data.value.avgWaifuScore) }}</span>
          <span class="text-fg-subtle">·</span>
          <span class="text-fg-subtle font-mono tabular-nums">{{ numberFormat.format(statsQuery.data.value.waifuCount) }}</span>
        </span>
        <template v-if="ratingCounts.length > 0">
          <span class="h-3 w-px bg-border-subtle" />
          <span
            v-for="r in ratingCounts"
            :key="r.rating"
            class="flex items-center gap-1"
            :title="r.full"
          >
            <span class="text-fg-subtle">{{ r.short }}</span>
            <span class="font-mono tabular-nums">{{ numberFormat.format(r.count) }}</span>
          </span>
        </template>
      </template>
    </template>
    <template v-else>
      {{ bottomBarInfo }}
    </template>
  </div>
</template>
