import type { MaybeRefOrGetter } from 'vue'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { computed, toValue } from 'vue'
import { v2GetPostsStats } from '@/api'
import { postFilter, queryKeys } from '@/shared'

/**
 * Aggregate stats of the filtered library (total, rating distribution, score
 * averages) — the footer and the right-pane overview read the same query.
 *
 * `stats` is undefined while it fails: a failed request must not leave the
 * previous view's numbers standing (which `keepPrevious` would otherwise do);
 * `failed` lets the caller say "unavailable" instead.
 */
export function usePostsStatsQuery(options: { enabled: MaybeRefOrGetter<boolean>, keepPrevious?: boolean }) {
  const query = useQuery({
    queryKey: computed(() => queryKeys.postsStats(postFilter.value)),
    queryFn: async () => {
      const resp = await v2GetPostsStats({ body: { ...postFilter.value } })
      return resp.data
    },
    enabled: () => toValue(options.enabled),
    staleTime: 1000 * 30,
    // 切筛选时保持上一组数字，新聚合到了再换 —— 不闪空。
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  })
  const failed = computed(() => query.isError.value)
  const stats = computed(() => failed.value ? undefined : query.data.value)
  return { stats, failed }
}

/** An average score for display: two decimals, "—" when there is none. */
export function formatAverage(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2)
}
