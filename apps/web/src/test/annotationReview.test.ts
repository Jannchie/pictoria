import type { TimelineEntryPublic } from '@/api'
import { beforeEach, describe, expect, it } from 'vitest'
import { canReview, endReview, reviewing, setReviewHost } from '@/shared/annotationReview'

function entry(kind: string, id = 1): TimelineEntryPublic {
  return {
    kind,
    id,
    createdAt: '2026-08-07T00:00:00Z',
    post: { id: 1, filePath: 'p', fileName: 'f', extension: 'png', sha256: 'h', width: 1, height: 1 },
  }
}

// startReview is imported lazily per test so the module state is the only shared thing.
async function start(e: TimelineEntryPublic) {
  const { startReview } = await import('@/shared/annotationReview')
  startReview(e)
}

describe('annotation review handoff', () => {
  beforeEach(() => setReviewHost(null))

  it('refuses a review when no session is running', async () => {
    // The history list renders on the annotate route whether or not a session has been
    // started, so a click on the config screen must not strand the state.
    expect(canReview(entry('pairwise'))).toBe(false)
    await start(entry('pairwise'))
    expect(reviewing.value).toBeNull()
  })

  it('refuses a kind the running session cannot render', async () => {
    setReviewHost('pairwise')
    expect(canReview(entry('absolute'))).toBe(false)
    expect(canReview(entry('flag'))).toBe(false)
    await start(entry('absolute'))
    expect(reviewing.value).toBeNull()
  })

  it('accepts a matching kind and hands the whole entry over', async () => {
    setReviewHost('pairwise')
    const e = entry('pairwise', 42)
    expect(canReview(e)).toBe(true)
    await start(e)
    expect(reviewing.value?.id).toBe(42)
  })

  it('drops the review when the session goes away', async () => {
    setReviewHost('absolute')
    await start(entry('absolute', 7))
    expect(reviewing.value).not.toBeNull()
    // Unmounting clears the host; a record left selected here would re-open on the
    // next session against a screen that never chose it.
    setReviewHost(null)
    expect(reviewing.value).toBeNull()
  })

  it('endreview keeps the host so judging continues', async () => {
    setReviewHost('pairwise')
    await start(entry('pairwise'))
    endReview()
    expect(reviewing.value).toBeNull()
    expect(canReview(entry('pairwise'))).toBe(true)
  })
})
