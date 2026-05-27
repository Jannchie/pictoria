import type { PostSimplePublic } from '@/api'
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useSelectedPostStats } from '@/composables/useSelectedPostStats'

function post(p: Partial<PostSimplePublic>): PostSimplePublic {
  return {
    id: 0,
    filePath: '',
    fileName: '',
    extension: 'jpg',
    rating: 0,
    score: 0,
    size: 0,
    width: 0,
    height: 0,
    colors: [],
    sha256: '',
    ...p,
  } as PostSimplePublic
}

describe('useselectedpoststats', () => {
  it('aggregates distributions, ranges and common fields', () => {
    const selected = ref([
      post({ id: 1, rating: 2, score: 3, extension: 'jpg', size: 100, width: 10, height: 20, filePath: 'a/b' }),
      post({ id: 2, rating: 2, score: 5, extension: 'png', size: 200, width: 30, height: 5, filePath: 'a/c' }),
    ])
    const s = useSelectedPostStats(selected)

    expect(s.totalSize.value).toBe(300)
    expect(s.ratingDist.value[2]).toBe(2)
    expect(s.scoreDist.value[3]).toBe(1)
    expect(s.scoreDist.value[5]).toBe(1)
    expect(s.extensionDist.value).toContainEqual(['jpg', 1])
    expect(s.extensionDist.value).toContainEqual(['png', 1])
    expect(s.widthRange.value).toEqual({ min: 10, max: 30 })
    expect(s.heightRange.value).toEqual({ min: 5, max: 20 })
    expect(s.commonFolder.value).toBe('a') // longest shared path prefix
    expect(s.commonRating.value).toBe(2) // both rated 2
    expect(s.commonScore.value).toBeNull() // 3 vs 5 differ
  })

  it('degrades to zeros/nulls on an empty selection', () => {
    const selected = ref<PostSimplePublic[]>([])
    const s = useSelectedPostStats(selected)

    expect(s.totalSize.value).toBe(0)
    expect(s.widthRange.value).toBeNull()
    expect(s.commonFolder.value).toBe('')
    expect(s.commonRating.value).toBeNull()
  })

  it('reacts when the selection changes', () => {
    const selected = ref<PostSimplePublic[]>([])
    const s = useSelectedPostStats(selected)
    expect(s.totalSize.value).toBe(0)

    selected.value = [post({ id: 3, size: 42 })]
    expect(s.totalSize.value).toBe(42)
  })
})
