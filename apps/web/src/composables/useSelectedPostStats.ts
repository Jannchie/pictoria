import type { Ref } from 'vue'
import type { PostSimplePublic } from '@/api'
import { computed } from 'vue'
import { MAX_POST_RATING, MAX_POST_SCORE } from '@/shared/ratings'

/** Min / max of the positive values `read` yields, or null when there are none. */
function positiveRange<T>(items: readonly T[], read: (item: T) => number): { min: number, max: number } | null {
  let min = Infinity
  let max = -Infinity
  for (const item of items) {
    const v = read(item)
    if (v > 0) {
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
  }
  return min === Infinity ? null : { min, max }
}

/**
 * Aggregations the multi-select panel shows for the current selection
 * (rating/score/extension distributions, size + dimension ranges, the common
 * folder/rating/score). All pure functions of the selected posts, lifted out
 * of `PostMultiSelectPanel` so the ~80 lines of reductions can be unit-tested
 * and the component keeps only its presentation.
 */
export function useSelectedPostStats(selectedPosts: Ref<PostSimplePublic[]>) {
  const totalSize = computed(() => selectedPosts.value.reduce((sum, p) => sum + (p.size ?? 0), 0))

  const ratingDist = computed(() => {
    const buckets = Array.from<number>({ length: MAX_POST_RATING + 1 }).fill(0)
    for (const p of selectedPosts.value) {
      const r = Math.max(0, Math.min(MAX_POST_RATING, p.rating ?? 0))
      buckets[r] += 1
    }
    return buckets
  })

  const scoreDist = computed(() => {
    const buckets = Array.from<number>({ length: MAX_POST_SCORE + 1 }).fill(0)
    for (const p of selectedPosts.value) {
      const s = Math.max(0, Math.min(MAX_POST_SCORE, p.score ?? 0))
      buckets[s] += 1
    }
    return buckets
  })

  const extensionDist = computed(() => {
    const map = new Map<string, number>()
    for (const p of selectedPosts.value) {
      map.set(p.extension, (map.get(p.extension) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  })

  // Plain loops, not Math.min(...arr): a Ctrl+A selection can be tens of
  // thousands of posts, past the engine's argument-count limit (RangeError).
  const widthRange = computed(() => positiveRange(selectedPosts.value, p => p.width))
  const heightRange = computed(() => positiveRange(selectedPosts.value, p => p.height))

  // Longest common path prefix (segment-wise) across all selected posts.
  const commonFolder = computed(() => {
    if (selectedPosts.value.length === 0) {
      return ''
    }
    const paths = selectedPosts.value.map(p => p.filePath.split('/').filter(Boolean))
    if (paths.length === 1) {
      return paths[0].join('/')
    }
    let minLen = Infinity
    for (const p of paths) {
      minLen = Math.min(minLen, p.length)
    }
    const out: string[] = []
    for (let i = 0; i < minLen; i++) {
      const seg = paths[0][i]
      if (paths.every(p => p[i] === seg)) {
        out.push(seg)
      }
      else {
        break
      }
    }
    return out.join('/')
  })

  const commonRating = computed<number | null>(() => {
    if (selectedPosts.value.length === 0) {
      return null
    }
    const first = selectedPosts.value[0].rating ?? 0
    return selectedPosts.value.every(p => (p.rating ?? 0) === first) ? first : null
  })
  const commonScore = computed<number | null>(() => {
    if (selectedPosts.value.length === 0) {
      return null
    }
    const first = selectedPosts.value[0].score ?? 0
    return selectedPosts.value.every(p => (p.score ?? 0) === first) ? first : null
  })

  return {
    totalSize,
    ratingDist,
    scoreDist,
    extensionDist,
    widthRange,
    heightRange,
    commonFolder,
    commonRating,
    commonScore,
  }
}
