import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  postFilter,
  postSort,
  postSortColor,
  postSortOrder,
  RATING_LEVEL_LABEL_KEYS,
  RATING_UNRATED_LABEL_KEY,
  textSearchQuery,
} from '@/shared'
import { naturalizeTagName } from '@/utils'

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

/** Bucket ids (`filter.bucket*` keys) used by the waifu / SILVA level facets. */
const BUCKET_LABEL_KEYS: Record<string, string> = {
  best: 'filter.bucketBest',
  good: 'filter.bucketGood',
  normal: 'filter.bucketNormal',
  bad: 'filter.bucketBad',
  worst: 'filter.bucketWorst',
}

type ArrayFacet = 'rating' | 'score' | 'extension' | 'tags' | 'waifu_score_levels' | 'silva_score_levels'

/** Drops one value from an array facet, leaving the rest of the filter alone. */
function removeFrom<T>(field: ArrayFacet, value: T) {
  const arr = postFilter.value[field] as unknown as T[]
  ;(postFilter.value[field] as unknown as T[]) = arr.filter(v => v !== value)
}

/** Clears every facet, the text search and the colour sort in one go. */
function clearAll() {
  postFilter.value = {
    ...postFilter.value,
    rating: [],
    score: [],
    tags: [],
    extension: [],
    waifu_score_levels: [],
    silva_score_levels: [],
    waifu_score_range: undefined,
  }
  textSearchQuery.value = ''
  postSortColor.value = undefined
}

/** Also resets the ordering — used by the "reset everything" affordance. */
function resetAll() {
  clearAll()
  postSort.value = 'id'
  postSortOrder.value = 'desc'
}

export function useActiveFilters() {
  const { t } = useI18n()

  function ratingLabel(r: number): string {
    return r === 0 ? t(RATING_UNRATED_LABEL_KEY) : t(RATING_LEVEL_LABEL_KEYS[r - 1] ?? 'rating.unknown')
  }

  function bucketLabel(id: string): string {
    const key = BUCKET_LABEL_KEYS[id.toLowerCase()]
    return key ? t(key) : id
  }

  const chips = computed<FilterChip[]>(() => {
    const f = postFilter.value
    const out: FilterChip[] = []

    if (textSearchQuery.value.trim()) {
      out.push({
        id: 'text',
        icon: 'i-tabler-search',
        label: textSearchQuery.value.trim(),
        remove: () => {
          textSearchQuery.value = ''
        },
      })
    }
    for (const r of f.rating) {
      out.push({ id: `rating:${r}`, icon: 'i-tabler-thumb-up', label: ratingLabel(r), remove: () => removeFrom('rating', r) })
    }
    for (const s of f.score) {
      out.push({ id: `score:${s}`, icon: 'i-tabler-star', label: t('filter.star', { n: s }, s), remove: () => removeFrom('score', s) })
    }
    for (const tag of f.tags) {
      out.push({ id: `tag:${tag}`, icon: 'i-tabler-tag', label: naturalizeTagName(tag), remove: () => removeFrom('tags', tag) })
    }
    for (const ext of f.extension) {
      out.push({ id: `ext:${ext}`, icon: 'i-tabler-file', label: ext || t('filter.noExtension'), remove: () => removeFrom('extension', ext) })
    }
    for (const lvl of f.waifu_score_levels) {
      out.push({ id: `waifu:${lvl}`, icon: 'i-tabler-heart', label: `Waifu ${bucketLabel(lvl)}`, remove: () => removeFrom('waifu_score_levels', lvl) })
    }
    for (const lvl of f.silva_score_levels) {
      out.push({ id: `silva:${lvl}`, icon: 'i-tabler-rosette', label: `SILVA ${bucketLabel(lvl)}`, remove: () => removeFrom('silva_score_levels', lvl) })
    }
    if (f.waifu_score_range) {
      const [lo, hi] = f.waifu_score_range
      out.push({
        id: 'waifu-range',
        icon: 'i-tabler-heart',
        label: `${lo}–${hi}`,
        remove: () => {
          postFilter.value.waifu_score_range = undefined
        },
      })
    }
    if (postSortColor.value) {
      out.push({
        id: 'sort-color',
        icon: 'i-tabler-palette',
        label: postSortColor.value.toUpperCase(),
        remove: () => {
          postSortColor.value = undefined
        },
      })
    }
    return out
  })

  const count = computed(() => chips.value.length)
  const isFiltered = computed(() => count.value > 0)

  return { chips, count, isFiltered, clearAll, resetAll }
}
