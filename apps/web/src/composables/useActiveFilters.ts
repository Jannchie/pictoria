import type { FilterChipTarget, Translate } from '@/shared/postFilter'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  postFilter,
  postSort,
  postSortColor,
  postSortOrder,
  textSearchQuery,
} from '@/shared'
import { clearFilter, filterChips, withoutFacetValue } from '@/shared/postFilter'

/**
 * One flattened, renderable view of everything currently narrowing the
 * gallery. The filter state itself is spread across `postFilter`'s six array
 * facets plus the sort/colour/text-search refs, and each facet's own button
 * only reflects itself — so nothing in the UI could answer "what am I looking
 * at right now?". This composable is that answer: a chip list any surface can
 * render, each chip knowing how to remove itself.
 */

export interface FilterChip {
  /** Stable identity for :key. */
  id: string
  icon: string
  label: string
  /** Clears just this chip's contribution to the filter. */
  remove: () => void
}

/** Clears every facet, the text search and the colour sort in one go. */
function clearAll() {
  postFilter.value = clearFilter(postFilter.value)
  textSearchQuery.value = ''
  postSortColor.value = undefined
}

/** Clears just what one chip contributes, leaving the rest of the filter alone. */
function removeTarget(target: FilterChipTarget) {
  switch (target.kind) {
    case 'text': {
      textSearchQuery.value = ''
      break
    }
    case 'facet': {
      postFilter.value[target.field] = withoutFacetValue(postFilter.value, target.field, target.value)[target.field] as never
      break
    }
    case 'waifuScoreRange': {
      postFilter.value.waifuScoreRange = undefined
      break
    }
    case 'sortColor': {
      postSortColor.value = undefined
      break
    }
  }
}

/** Also resets the ordering — used by the "reset everything" affordance. */
function resetAll() {
  clearAll()
  postSort.value = 'id'
  postSortOrder.value = 'desc'
}

export function useActiveFilters() {
  const { t } = useI18n()
  // 只有 `t(key)` 和 `t(key, named, plural)` 两种调用形态，分开转发以保持原样。
  const translate: Translate = (key, named, plural) =>
    named === undefined ? t(key) : t(key, named, plural ?? 1)

  const chips = computed<FilterChip[]>(() =>
    filterChips({ filter: postFilter.value, text: textSearchQuery.value, sortColor: postSortColor.value }, translate)
      .map(({ target, ...chip }) => ({ ...chip, remove: () => removeTarget(target) })),
  )

  const count = computed(() => chips.value.length)
  const isFiltered = computed(() => count.value > 0)

  return { chips, count, isFiltered, clearAll, resetAll }
}
