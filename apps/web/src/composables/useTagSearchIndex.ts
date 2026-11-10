import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'

interface SearchableTag {
  name: string
  translatedName?: string | null
}

export interface TagSearchIndex<T extends SearchableTag> {
  /** Catalogue order, each tag with its lower-cased `name|translatedName`. */
  entries: readonly (readonly [T, string])[]
  /** Exact tag names, for "does this tag already exist". */
  names: ReadonlySet<string>
}

// One index per catalogue array: the tag editor and the batch picker read the
// same cached array (useTagCatalogueQuery), so they share one index too.
const cache = new WeakMap<readonly SearchableTag[], TagSearchIndex<SearchableTag>>()

function buildIndex<T extends SearchableTag>(tags: readonly T[]): TagSearchIndex<T> {
  const hit = cache.get(tags)
  if (hit) {
    return hit as TagSearchIndex<T>
  }
  const entries: (readonly [T, string])[] = []
  const names = new Set<string>()
  for (const tag of tags) {
    // `|` 只是防止跨字段误匹配的分隔符：tag 名是下划线英文，译名是中日文，都不含它。
    entries.push([tag, `${tag.name}|${tag.translatedName ?? ''}`.toLowerCase()])
    names.add(tag.name)
  }
  const index = { entries, names }
  cache.set(tags, index)
  return index
}

/**
 * Lower-cased search text per tag, built once per catalogue array rather than
 * on every keystroke: the catalogue has tens of thousands of tags, and
 * re-lowercasing all of them per key froze the input for hundreds of ms.
 */
export function useTagSearchIndex<T extends SearchableTag>(tags: MaybeRefOrGetter<readonly T[]>) {
  return computed(() => buildIndex(toValue(tags)))
}
