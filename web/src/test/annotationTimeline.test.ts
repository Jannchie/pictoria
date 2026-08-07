import type { QueueItemPostPublic, TimelinePagePublic } from '@/api'
import { QueryClient } from '@tanstack/vue-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { patchEntry, prependEntry, removeEntries } from '@/shared/annotationTimeline'
import { queryKeys } from '@/shared/queryKeys'

function post(id: number): QueueItemPostPublic {
  return { id, filePath: 'p', fileName: `f${id}`, extension: 'png', sha256: `h${id}`, width: 10, height: 10 }
}

function page(items: TimelinePagePublic['items'], nextCursor: string | null = null): TimelinePagePublic {
  return { items, nextCursor }
}

function entry(kind: string, id: number, extra: Record<string, unknown> = {}) {
  return { kind, id, createdAt: '2026-08-07T00:00:00Z', cursor: `c${id}`, post: post(1), ...extra } as TimelinePagePublic['items'][number]
}

let client: QueryClient
function cache() {
  return client.getQueryData(queryKeys.annotationTimeline) as { pages: TimelinePagePublic[] } | undefined
}
function ids() {
  return cache()?.pages.flatMap(p => p.items.map(i => i.id)) ?? []
}

describe('annotation timeline cache patches', () => {
  beforeEach(() => {
    client = new QueryClient()
  })

  it('do nothing when the sidebar was never opened', () => {
    // The session calls these on every judgement, so they have to be free when the
    // query has never been fetched — not seed a bogus first page.
    prependEntry(client, { kind: 'pairwise', id: 1, post: post(1), postB: post(2), dimension: 'overall', winner: 'a' })
    removeEntries(client, 'pairwise', [1])
    patchEntry(client, 'pairwise', 1, { winner: 'tie' })
    expect(cache()).toBeUndefined()
  })

  it('puts a new judgement at the head of the first page', () => {
    client.setQueryData(queryKeys.annotationTimeline, { pages: [page([entry('pairwise', 7)])], pageParams: [''] })
    prependEntry(client, { kind: 'pairwise', id: 9, post: post(1), postB: post(2), dimension: 'overall', winner: 'b' })
    expect(ids()).toEqual([9, 7])
    const head = cache()!.pages[0]!.items[0]!
    expect(head.winner).toBe('b')
    expect(head.postB?.id).toBe(2)
  })

  it('keeps the paging cursor of the page it prepends into', () => {
    // The cursor belongs to the PAGE, not the row: clobbering it would make the next
    // fetchNextPage resume from the wrong place or stop early.
    client.setQueryData(queryKeys.annotationTimeline, { pages: [page([entry('pairwise', 7)], 'cursor-7')], pageParams: [''] })
    prependEntry(client, { kind: 'pairwise', id: 9, post: post(1), postB: post(2), dimension: 'overall', winner: 'a' })
    expect(cache()!.pages[0]!.nextCursor).toBe('cursor-7')
  })

  it('records one row per absolute event, and can carry a content flag too', () => {
    client.setQueryData(queryKeys.annotationTimeline, { pages: [page([])], pageParams: [''] })
    prependEntry(client, { kind: 'absolute', id: 1, post: post(3), dimension: 'color', scale: 5, value: 4 })
    prependEntry(client, { kind: 'absolute', id: 2, post: post(3), dimension: 'finish', scale: 5, value: 2 })
    expect(ids()).toEqual([2, 1])
    expect(cache()!.pages[0]!.items[1]!.value).toBe(4)
    // The third stream goes through the same door — a per-kind wrapper would have been
    // a third copy of the body.
    prependEntry(client, { kind: 'flag', id: 3, post: post(3), flag: 'love' })
    expect(cache()!.pages[0]!.items[0]!.flag).toBe('love')
  })

  it('removes undone events across every loaded page, matching on kind too', () => {
    client.setQueryData(queryKeys.annotationTimeline, {
      pages: [page([entry('pairwise', 1), entry('absolute', 2)]), page([entry('pairwise', 2)])],
      pageParams: ['', 'c'],
    })
    removeEntries(client, 'pairwise', [2])
    // The absolute row also has id 2 — ids only increase within a table, so an undo
    // that matched on id alone would take out an unrelated event.
    expect(cache()!.pages[0]!.items.map(i => `${i.kind}-${i.id}`)).toEqual(['pairwise-1', 'absolute-2'])
    expect(cache()!.pages[1]!.items).toEqual([])
  })

  it('mirrors a corrected verdict and its edited marker', () => {
    client.setQueryData(queryKeys.annotationTimeline, { pages: [page([entry('pairwise', 5, { winner: 'a' })])], pageParams: [''] })
    patchEntry(client, 'pairwise', 5, { winner: 'tie', editedAt: '2026-08-07T01:00:00Z' })
    const row = cache()!.pages[0]!.items[0]!
    expect(row.winner).toBe('tie')
    expect(row.editedAt).toBe('2026-08-07T01:00:00Z')
  })
})
