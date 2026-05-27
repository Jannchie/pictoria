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

type PostFilterValue = typeof postFilter.value
type ArrayFilterField = 'rating' | 'score' | 'extension' | 'waifu_score_levels'

export function useFacetFilter<T extends string | number, TRow>(opts: {
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

  return { selected, has, toggle, filterWithoutSelf, countQuery }
}
