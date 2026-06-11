import type { CountKind } from '@/shared'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { postFilter, queryKeys } from '@/shared'

/**
 * Shared behaviour behind the gallery's faceted filters (rating / score /
 * extension / waifu bucket). Each filter used to repeat the same ~25 lines:
 * a get/set computed bound to its `postFilter` field, add/remove toggling, a
 * "filter without myself" projection, and a count query keyed off it. That
 * logic lives here once; the four components keep only their own option list
 * and row rendering.
 */

export type PostFilterValue = typeof postFilter.value
type ArrayFilterField = 'rating' | 'score' | 'extension' | 'waifu_score_levels' | 'silva_score_levels'

/**
 * Percentage share of `count` in `total`, formatted to one decimal ('0.0' when
 * the total is unknown/zero). Exported standalone for TagFilter, whose
 * denominator is a separate posts-count query (tags aren't mutually exclusive)
 * rather than the sum of its facet rows.
 */
export function formatPct(count: number, total: number): string {
  return total > 0 ? ((count / total) * 100).toFixed(1) : '0.0'
}

export function useFacetFilter<T extends string | number, TRow extends { count: number }>(opts: {
  field: ArrayFilterField
  countKind: CountKind
  fetchCounts: (filter: PostFilterValue) => Promise<TRow[] | undefined>
}) {
  // postFilter mixes array facets with scalar ones (folder, waifu_score_range),
  // so narrow to "the array facets" before indexing by the chosen field. Read
  // through postFilter.value each time to track reactivity exactly as before.
  const selected = computed<T[]>({
    get: () => (postFilter.value as unknown as Record<ArrayFilterField, T[]>)[opts.field],
    set: (value) => {
      (postFilter.value as unknown as Record<ArrayFilterField, T[]>)[opts.field] = value
    },
  })

  function has(value: T): boolean {
    return selected.value.includes(value)
  }
  function toggle(value: T): void {
    selected.value = has(value)
      ? selected.value.filter(v => v !== value)
      : [...selected.value, value]
  }

  // The popover counts show how many posts each option *would* match if this
  // facet were cleared, so zero out only this field before counting.
  const filterWithoutSelf = computed(() => ({ ...postFilter.value, [opts.field]: [] }) as PostFilterValue)

  const countQuery = useQuery({
    queryKey: queryKeys.count(opts.countKind, filterWithoutSelf),
    queryFn: async () => opts.fetchCounts(filterWithoutSelf.value),
  })

  // The facet's options are mutually exclusive, so the rows sum to the post
  // total and each option's share is count/total.
  const total = computed(() => (countQuery.data.value ?? []).reduce((sum, row) => sum + row.count, 0))
  function pct(count: number): string {
    return formatPct(count, total.value)
  }

  return { selected, has, toggle, filterWithoutSelf, countQuery, total, pct }
}
