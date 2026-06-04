import { QueryClient } from '@tanstack/vue-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/api'
import { localeSetting } from '@/locale'
import { canUndo, clearHistory, redo, undo } from '@/shared/history'
import { captureOldValues, commitRating, commitScore, commitTag, deletePosts, groupIdsByValue, removePostsFromCacheEntry } from '@/shared/mutations'
import { queryKeys } from '@/shared/queryKeys'

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
  v2DeletePosts: vi.fn(async () => ({})),
  v2GetFolders: vi.fn(async () => ({})),
  v2SearchPosts: vi.fn(async () => ({})),
}))

describe('groupidsbyvalue', () => {
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

describe('captureoldvalues', () => {
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
    // Pin the locale: the note copy is asserted literally below, and 'auto'
    // would resolve differently depending on the host machine's language.
    localeSetting.value = 'en'
    clearHistory()
    vi.clearAllMocks()
  })

  it('commitscore: single uses single endpoint, pushes a command', async () => {
    await commitScore(qc, [{ id: 1, score: 2 }], [1], 5)
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 5 } })
    expect(canUndo.value).toBe(true)
  })

  it('commitscore: bulk write + grouped revert restores per-post old values', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })

    vi.clearAllMocks()
    const r = await undo()
    expect(r.status).toBe('done')
    // 旧值不同 → 分两组，各 1 个 id → 走单条端点
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 1 } })
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 2 }, body: { score: 4 } })
  })

  it('commitscore: redo re-applies the new value to all ids', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    await undo()
    vi.clearAllMocks()
    await redo()
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })
  })

  it('commitscore: notes when some selected ids are not loaded', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }], [1, 99], 5)
    const r = await undo()
    expect(r.status).toBe('done')
    if (r.status === 'done') {
      expect(r.command.note).toContain('not loaded')
    }
  })

  it('commitrating: single uses query param endpoint', async () => {
    await commitRating(qc, [{ id: 1, rating: 0 }], [1], 3)
    expect(api.v2UpdatePostRating).toHaveBeenCalledWith({ path: { post_id: 1 }, query: { rating: 3 } })
  })

  it('committag: add then undo removes, redo re-adds', async () => {
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

describe('removepostsfromcacheentry', () => {
  it('removes ids from the infinite-list { pages } shape', () => {
    const old = { pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]], pageParams: [0, 1] }
    const out = removePostsFromCacheEntry(old, new Set([2])) as typeof old
    expect(out.pages).toEqual([[{ id: 1 }], [{ id: 3 }]])
    expect(out.pageParams).toEqual([0, 1])
  })

  it('removes ids from a flat array (text-search / similar / group results)', () => {
    const out = removePostsFromCacheEntry([{ id: 1 }, { id: 2 }, { id: 3 }], new Set([1, 3]))
    expect(out).toEqual([{ id: 2 }])
  })

  it('leaves non-list cache entries (stats object, null) untouched', () => {
    expect(removePostsFromCacheEntry(null, new Set([1]))).toBeNull()
    const stats = { total: 5 }
    expect(removePostsFromCacheEntry(stats, new Set([1]))).toBe(stats)
  })
})

describe('deleteposts', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes via the api and drops the posts from gallery, text-search & similar caches', async () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.textSearch('cat', {}), [{ id: 1 }, { id: 2 }])
    qc.setQueryData(queryKeys.similarPosts(7), [{ id: 2 }, { id: 9 }])
    qc.setQueryData(queryKeys.posts({ folder: 'a' }), { pages: [[{ id: 1 }, { id: 2 }]], pageParams: [0] })

    await deletePosts(qc, [2])

    expect(api.v2DeletePosts).toHaveBeenCalledWith({ query: { ids: [2] } })
    // text-search / similar are flat arrays keyed off a non-`posts` prefix — the
    // old bare invalidate(['posts']) never touched these, so the card lingered.
    expect(qc.getQueryData(queryKeys.textSearch('cat', {}))).toEqual([{ id: 1 }])
    expect(qc.getQueryData(queryKeys.similarPosts(7))).toEqual([{ id: 9 }])
    expect((qc.getQueryData(queryKeys.posts({ folder: 'a' })) as { pages: unknown[] }).pages).toEqual([[{ id: 1 }]])
  })

  it('batches deletes into chunks of 100', async () => {
    const qc = new QueryClient()
    const ids = Array.from({ length: 150 }, (_, i) => i + 1)
    await deletePosts(qc, ids)
    expect(api.v2DeletePosts).toHaveBeenCalledTimes(2)
    const calls = (api.v2DeletePosts as unknown as { mock: { calls: [{ query: { ids: number[] } }][] } }).mock.calls
    expect(calls[0][0].query.ids).toHaveLength(100)
    expect(calls[1][0].query.ids).toHaveLength(50)
  })

  it('does nothing for an empty id list', async () => {
    const qc = new QueryClient()
    await deletePosts(qc, [])
    expect(api.v2DeletePosts).not.toHaveBeenCalled()
  })
})
