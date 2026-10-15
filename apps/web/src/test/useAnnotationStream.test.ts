// @vitest-environment happy-dom
import type { QueueSummaryPublic } from '@/api'
import type { AnnotationStreamOptions } from '@/composables/useAnnotationStream'
import { QueryClient } from '@tanstack/vue-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import * as api from '@/api'
import { useAnnotationStream } from '@/composables/useAnnotationStream'
import { localeSetting } from '@/locale'
import { clearHistory, redo, undo } from '@/shared/history'

vi.mock('@/api', () => ({
  v2UndoAnnotations: vi.fn(async () => ({})),
}))

interface Item { id: number, position?: number }

/** A fetchBatch that serves the given batches in order, then empty batches. */
function batches(...list: Item[][]) {
  const queue = [...list]
  return vi.fn(async () => queue.shift() ?? [])
}

function setup(overrides: Partial<AnnotationStreamOptions<Item>> = {}) {
  const scope = effectScope()
  const stream = scope.run(() => useAnnotationStream<Item>({
    kind: 'pairwise',
    queryClient: new QueryClient(),
    sessionId: 'session',
    queue: undefined,
    fetchBatch: batches(),
    keyOf: i => (i.position == null ? `p${i.id}` : `q${i.position}`),
    lowWater: 3,
    emptyLimit: 2,
    preload: { ahead: 1, item: () => {} },
    onLoadError: () => {},
    streamProgress: { labelKey: 'annotate.progress.pairwise', announceKey: 'annotate.progress.pairwiseAnnounce' },
    postIdsOf: i => [i.id],
    ...overrides,
  }))!
  return stream
}

const ids = (items: Item[]) => items.map(i => i.id)

beforeEach(() => {
  localeSetting.value = 'en'
  clearHistory()
  vi.clearAllMocks()
})

describe('refill', () => {
  it('fills below the low-water mark and stops once at or above it', async () => {
    const fetchBatch = batches([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 4 }])
    const s = setup({ fetchBatch })
    await s.refill()
    expect(ids(s.buffer.value)).toEqual([1, 2, 3])
    await s.refill() // 3 >= lowWater 3: no request
    expect(fetchBatch).toHaveBeenCalledTimes(1)
  })

  it('lets only one refill run at a time', async () => {
    const fetchBatch = batches([{ id: 1 }])
    const s = setup({ fetchBatch })
    await Promise.all([s.refill(), s.refill()])
    expect(fetchBatch).toHaveBeenCalledTimes(1)
    expect(ids(s.buffer.value)).toEqual([1])
  })

  it('reports a failed batch and keeps going', async () => {
    const onLoadError = vi.fn()
    const s = setup({ fetchBatch: vi.fn(async () => {
      throw new Error('boom')
    }), onLoadError })
    await s.refill()
    expect(onLoadError).toHaveBeenCalledOnce()
    expect(s.exhausted.value).toBe(false)
  })
})

describe('de-duplication', () => {
  it('stream mode: a key is shown at most once per session, within and across batches', async () => {
    const s = setup({ fetchBatch: batches([{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 2 }]) })
    await s.refill()
    expect(ids(s.buffer.value)).toEqual([1])
    s.advance() // buffer empty → next batch; 1 was already shown
    await vi.waitFor(() => expect(ids(s.buffer.value)).toEqual([2]))
  })

  it('queue mode: only items already in the buffer are dropped', async () => {
    const queue = ref<QueueSummaryPublic | undefined>({ id: 9, done: 0, total: 10 } as QueueSummaryPublic)
    const s = setup({
      queue,
      fetchBatch: batches([{ id: 1, position: 0 }, { id: 2, position: 1 }], [{ id: 2, position: 1 }, { id: 1, position: 0 }]),
      lowWater: 5,
    })
    await s.refill()
    s.buffer.value.shift() // position 0 left the buffer; position 1 is still in it
    await s.refill()
    expect(s.buffer.value.map(i => i.position)).toEqual([1, 0])
  })

  it('forget lets a remembered key back in (local skip undo)', async () => {
    const s = setup({ fetchBatch: batches([{ id: 1 }], [{ id: 1 }]) })
    await s.refill()
    s.buffer.value.shift()
    s.forget('p1')
    await s.refill()
    expect(ids(s.buffer.value)).toEqual([1])
  })
})

describe('running dry', () => {
  it('retries an empty batch once and gives up on the second in a row', async () => {
    const fetchBatch = batches([], [])
    const s = setup({ fetchBatch })
    await s.refill()
    expect(fetchBatch).toHaveBeenCalledTimes(2)
    expect(s.exhausted.value).toBe(true)
    await s.refill() // exhausted: no more requests
    expect(fetchBatch).toHaveBeenCalledTimes(2)
  })

  it('a non-empty batch resets the streak', async () => {
    const fetchBatch = batches([], [{ id: 1 }])
    const s = setup({ fetchBatch })
    await s.refill()
    expect(s.exhausted.value).toBe(false)
    expect(ids(s.buffer.value)).toEqual([1])
  })

  it('emptylimit 1: the first empty batch ends the stream, without a retry', async () => {
    const fetchBatch = batches([])
    const s = setup({ fetchBatch, emptyLimit: 1 })
    await s.refill()
    expect(fetchBatch).toHaveBeenCalledTimes(1)
    expect(s.exhausted.value).toBe(true)
  })

  it('reset starts over: buffer, seen keys, streak, exhausted and the done count', async () => {
    const queue = ref<QueueSummaryPublic | undefined>(undefined)
    const fetchBatch = batches([{ id: 1 }], [], [], [{ id: 1 }])
    const s = setup({ fetchBatch, queue, lowWater: 2 })
    await s.refill() // [1], then the retry-free path: buffer below 2 is fine
    s.advance()
    await vi.waitFor(() => expect(s.exhausted.value).toBe(true))
    expect(s.doneCount.value).toBe(1)
    s.reset()
    expect(s.exhausted.value).toBe(false)
    expect(s.doneCount.value).toBe(0)
    await vi.waitFor(() => expect(ids(s.buffer.value)).toEqual([1]))
  })
})

/** One item judged and advanced past, ready for pushUndoable. */
async function judged(overrides: Partial<AnnotationStreamOptions<Item>> = {}) {
  const s = setup({ fetchBatch: batches([{ id: 1 }, { id: 2 }]), lowWater: 1, ...overrides })
  await s.refill()
  const item = s.current.value!
  s.advance()
  const onRevert = vi.fn()
  const redoWrite = vi.fn(async () => {
    s.advance()
    return [77]
  })
  return { s, item, onRevert, redoWrite }
}

describe('undo of a judgement', () => {
  it('deletes the events and puts the item back with the count rolled back', async () => {
    const { s, item, onRevert, redoWrite } = await judged()
    s.exhausted.value = true
    s.pushUndoable({ item, ids: [41], label: 'judge', redo: redoWrite, onRevert })
    expect(s.doneCount.value).toBe(1)

    await undo()
    expect(api.v2UndoAnnotations).toHaveBeenCalledWith({
      body: { kind: 'pairwise', ids: [41], sessionId: 'session', queueId: null, queuePosition: null },
    })
    expect(s.current.value).toEqual(item)
    expect(ids(s.buffer.value)).toEqual([1, 2])
    expect(s.doneCount.value).toBe(0)
    expect(s.exhausted.value).toBe(false)
    expect(onRevert).toHaveBeenCalledOnce()
  })

  it('redo writes again and the next undo deletes the new event ids', async () => {
    const { s, item, onRevert, redoWrite } = await judged()
    s.pushUndoable({ item, ids: [41], label: 'judge', redo: redoWrite, onRevert })
    await undo()
    await redo()
    expect(redoWrite).toHaveBeenCalledOnce()
    expect(s.doneCount.value).toBe(1)
    vi.mocked(api.v2UndoAnnotations).mockClear()
    await undo()
    expect(vi.mocked(api.v2UndoAnnotations).mock.calls[0]![0]!.body.ids).toEqual([77])
  })

  it('when the session moved on, only the events are deleted', async () => {
    const { s, item, onRevert, redoWrite } = await judged()
    s.pushUndoable({ item, ids: [41], label: 'judge', redo: redoWrite, onRevert, stillHere: () => false })
    await undo()
    expect(api.v2UndoAnnotations).toHaveBeenCalledOnce()
    expect(ids(s.buffer.value)).toEqual([2])
    expect(s.doneCount.value).toBe(1)
    expect(onRevert).not.toHaveBeenCalled()
  })

  it('never drives the done count below zero', async () => {
    const { s, item, redoWrite } = await judged()
    s.doneCount.value = 0
    s.pushUndoable({ item, ids: [], label: 'skip', redo: redoWrite })
    await undo()
    expect(s.doneCount.value).toBe(0)
  })
})

describe('progress label', () => {
  it('stream mode counts this session; queue mode shows done / total', () => {
    const queue = ref<QueueSummaryPublic | undefined>(undefined)
    const s = setup({ queue })
    s.doneCount.value = 3
    expect(s.progressLabel.value).toContain('3')
    queue.value = { id: 1, done: 3, total: 20 } as QueueSummaryPublic
    expect(s.progressLabel.value).toContain('20')
  })

  it('submitcurrent holds the in-flight flag and reports failures', async () => {
    const s = setup({ fetchBatch: batches([{ id: 1 }]) })
    await s.refill()
    const onError = vi.fn()
    let during = false
    await s.submitCurrent(async () => {
      during = s.submitting.value
      throw new Error('nope')
    }, onError)
    expect(during).toBe(true)
    expect(s.submitting.value).toBe(false)
    expect(onError).toHaveBeenCalledOnce()
  })
})
