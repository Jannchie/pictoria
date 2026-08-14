import type { Ref } from 'vue'
import type { CountKind } from '@/shared'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
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
type ArrayFilterField = 'rating' | 'score' | 'extension' | 'waifu_score_levels' | 'silva_score_levels' | 'silva_luna_score_levels'

/**
 * Percentage share of `count` in `total`, formatted to one decimal ('0.0' when
 * the total is unknown/zero). Exported standalone for TagFilter, whose
 * denominator is a separate posts-count query (tags aren't mutually exclusive)
 * rather than the sum of its facet rows.
 */
export function formatPct(count: number, total: number): string {
  return total > 0 ? ((count / total) * 100).toFixed(1) : '0.0'
}

/**
 * 弹层门控的计数查询共用选项 —— 每个 facet 计数查询（这里的 countQuery 和
 * TagFilter 的两个）都必须 spread 它，`query-conventions.test.ts` 有静态守卫。
 *
 * `enabled`：数字只在弹层里可见，弹层没开就不发请求（门控的性能理由见下面
 * `opened` 的注释）。`staleTime`：30s 内重开同一筛选不重发。`keepPreviousData`：
 * 弹层开着切筛选时保留旧行，不闪零。
 */
export function gatedCountOptions(opened: Ref<boolean>) {
  return { enabled: opened, staleTime: 30_000, placeholderData: keepPreviousData } as const
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

  // Popover-open gate. Without it, toggling ANY facet changes every other
  // facet's filterWithoutSelf, so one click used to fan out into 6–8 aggregate
  // queries at once — each a full-table GROUP BY (~85–100 ms measured on the
  // 223k library) queueing on the API's single synchronous better-sqlite3
  // connection: ~850 ms of blocked event loop per filter switch. Counts are
  // only visible inside the popover, so only fetch while it is open; the
  // component binds this to PPopover's v-model.
  const opened = ref(false)

  const countQuery = useQuery({
    queryKey: queryKeys.count(opts.countKind, filterWithoutSelf),
    queryFn: async () => opts.fetchCounts(filterWithoutSelf.value),
    ...gatedCountOptions(opened),
  })

  // The facet's options are mutually exclusive, so the rows sum to the post
  // total and each option's share is count/total.
  const total = computed(() => (countQuery.data.value ?? []).reduce((sum, row) => sum + row.count, 0))
  function pct(count: number): string {
    return formatPct(count, total.value)
  }

  return { selected, has, toggle, filterWithoutSelf, countQuery, total, pct, opened }
}
