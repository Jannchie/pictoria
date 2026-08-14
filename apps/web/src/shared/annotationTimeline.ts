import type { InfiniteData, QueryClient } from '@tanstack/vue-query'
import type { TimelineEntryPublic, TimelinePagePublic } from '@/api'
import { i18n } from '@/locale'
import { queryKeys } from './queryKeys'

/**
 * Cache patches for the annotation history sidebar.
 *
 * The list is an infinite query whose HEAD is being written by the same screen that
 * displays it — you judge a pair and it has to appear at the top immediately. Doing
 * that with `invalidateQueries` would re-run *every* loaded page on every judgement
 * (TanStack refetches an infinite query as a whole), i.e. a growing pile of requests
 * once a second. So the three things the session can do to the stream — submit, undo,
 * correct — are applied straight to the cache instead.
 *
 * All three are no-ops when the query has never been fetched (the sidebar was never
 * opened), which is what keeps them free to call unconditionally from the hot path.
 */

type Cache = InfiniteData<TimelinePagePublic> | undefined

function patchPages(client: QueryClient, fn: (pages: TimelinePagePublic[]) => TimelinePagePublic[]): void {
  client.setQueryData<Cache>(queryKeys.annotationTimeline, (old) => {
    if (!old) {
      return old
    }
    return { ...old, pages: fn(old.pages) }
  })
}

/**
 * Put a locally-known event at the head of the list without refetching.
 *
 * `createdAt` defaults to the client clock against the server's `datetime('now')`.
 * The list renders relative times ("2 分钟前"), so a second of skew is invisible, and
 * the row is replaced by the server's own copy on the next refetch.
 *
 * One function rather than one per kind: the kinds differ only in which verdict field
 * they carry, and the caller is already assembling those fields. A per-kind wrapper
 * would be a third copy of this body the day a fourth event stream appears.
 */
export function prependEntry(
  client: QueryClient,
  entry: Partial<TimelineEntryPublic> & Pick<TimelineEntryPublic, 'kind' | 'id' | 'post'>,
): void {
  patchPages(client, ([first, ...rest]) => {
    if (!first) {
      return []
    }
    const item: TimelineEntryPublic = { createdAt: new Date().toISOString(), ...entry }
    return [{ ...first, items: [item, ...first.items] }, ...rest]
  })
}

/** Undo deleted these rows server-side; drop them here so the list agrees. */
export function removeEntries(client: QueryClient, kind: string, ids: number[]): void {
  if (ids.length === 0) {
    return
  }
  const gone = new Set(ids)
  patchPages(client, pages => pages.map(page => ({
    ...page,
    items: page.items.filter(i => !(i.kind === kind && gone.has(i.id))),
  })))
}

/** A verdict was corrected in place; mirror the new value and the edited marker. */
export function patchEntry(client: QueryClient, kind: string, id: number, patch: Partial<TimelineEntryPublic>): void {
  patchPages(client, pages => pages.map(page => ({
    ...page,
    items: page.items.map(i => (i.kind === kind && i.id === id ? { ...i, ...patch } : i)),
  })))
}

/** Verdict → its translated label. One map, shared by the list and the session banner. */
const VERDICT_KEYS: Record<string, string> = {
  a: 'annotate.history.pickA',
  b: 'annotate.history.pickB',
  tie: 'annotate.history.tie',
  skip: 'annotate.history.skip',
}

export function winnerLabel(winner: string | null | undefined): string {
  return i18n.global.t(VERDICT_KEYS[winner ?? ''] ?? 'annotate.history.unknownVerdict')
}

/** Content-flag glyph. Anything that is not an explicit 'love' reads as the negative one. */
export function flagGlyph(flag: string | null | undefined): string {
  return flag === 'love' ? '❤️' : '💢'
}
