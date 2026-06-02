import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/api'
import { canUndo, clearHistory, redo, undo } from '@/shared/history'
import { captureOldValues, commitRating, commitScore, commitTag, groupIdsByValue } from '@/shared/mutations'

vi.mock('@/api', () => ({
  v2UpdatePostScore: vi.fn(async () => ({})),
  v2BulkUpdatePostScore: vi.fn(async () => ({})),
  v2UpdatePostRating: vi.fn(async () => ({})),
  v2BulkUpdatePostRating: vi.fn(async () => ({})),
  v2UpdatePostCaption: vi.fn(async () => ({})),
  v2UpdatePostSource: vi.fn(async () => ({})),
  v2AddTagToPost: vi.fn(async () => ({})),
  v2RemoveTagFromPost: vi.fn(async () => ({})),
  v2RotatePostImage: vi.fn(async () => ({})),
  v2GetFolders: vi.fn(async () => ({})),
  v2SearchPosts: vi.fn(async () => ({})),
}))

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

const qc = { invalidateQueries: vi.fn(), setQueriesData: vi.fn() } as any

describe('commit factories', () => {
  beforeEach(() => {
    clearHistory()
    vi.clearAllMocks()
  })

  it('commitScore: single uses single endpoint, pushes a command', async () => {
    await commitScore(qc, [{ id: 1, score: 2 }], [1], 5)
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 5 } })
    expect(canUndo.value).toBe(true)
  })

  it('commitScore: bulk write + grouped revert restores per-post old values', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })

    vi.clearAllMocks()
    const r = await undo()
    expect(r.status).toBe('done')
    // 旧值不同 → 分两组，各 1 个 id → 走单条端点
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 1 } })
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 2 }, body: { score: 4 } })
  })

  it('commitScore: redo re-applies the new value to all ids', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    await undo()
    vi.clearAllMocks()
    await redo()
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })
  })

  it('commitScore: notes when some selected ids are not loaded', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }], [1, 99], 5)
    const r = await undo()
    expect(r.status).toBe('done')
    if (r.status === 'done') {
      expect(r.command.note).toContain('未加载')
    }
  })

  it('commitRating: single uses query param endpoint', async () => {
    await commitRating(qc, [{ id: 1, rating: 0 }], [1], 3)
    expect(api.v2UpdatePostRating).toHaveBeenCalledWith({ path: { post_id: 1 }, query: { rating: 3 } })
  })

  it('commitTag: add then undo removes, redo re-adds', async () => {
    await commitTag(qc, 7, 'cat', true)
    expect(api.v2AddTagToPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })

    vi.clearAllMocks()
    await undo()
    expect(api.v2RemoveTagFromPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })

    vi.clearAllMocks()
    await redo()
    expect(api.v2AddTagToPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })
  })
})
