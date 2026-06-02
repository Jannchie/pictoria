import { describe, expect, it } from 'vitest'
import { captureOldValues, groupIdsByValue } from '@/shared/mutations'

describe('groupIdsByValue', () => {
  it('groups ids that share the same value', () => {
    const groups = groupIdsByValue([
      { id: 1, value: 5 },
      { id: 2, value: 3 },
      { id: 3, value: 5 },
    ])
    expect(groups.get(5)).toEqual([1, 3])
    expect(groups.get(3)).toEqual([2])
    expect(groups.size).toBe(2)
  })
})

describe('captureOldValues', () => {
  it('captures values for known posts and reports missing ids', () => {
    const posts = [{ id: 1, score: 4 }, { id: 2, score: 2 }]
    const { captured, missingIds } = captureOldValues(posts, [1, 2, 9], p => p.score)
    expect(captured).toEqual([{ id: 1, value: 4 }, { id: 2, value: 2 }])
    expect(missingIds).toEqual([9])
  })
})
