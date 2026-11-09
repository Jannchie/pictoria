import type { QueuesStatus } from '@/api'
import { describe, expect, it } from 'vitest'
import { syncNotice, syncNoticeCopy } from '@/shared/syncStatus'

function status(state: QueuesStatus['scheduler']['state'], error: string | null = null): QueuesStatus {
  return { scheduler: { state, error }, loops: [], queues: [] } as unknown as QueuesStatus
}

describe('syncnotice', () => {
  it('reports nothing while the scheduler is starting or running', () => {
    expect(syncNotice(status('starting'), false)).toBeNull()
    expect(syncNotice(status('running'), false)).toBeNull()
    expect(syncNotice(undefined, false)).toBeNull()
  })

  it('carries the scheduler error for the states that have one', () => {
    expect(syncNotice(status('retrying', 'locked'), false)).toEqual({ kind: 'scheduler', state: 'retrying', error: 'locked' })
    expect(syncNotice(status('failed', 'boom'), false)).toEqual({ kind: 'scheduler', state: 'failed', error: 'boom' })
    expect(syncNotice(status('disabled'), false)).toEqual({ kind: 'scheduler', state: 'disabled', error: null })
  })

  // TanStack keeps the last data through a failed refetch: the sidebar used to
  // show that frozen "processing" snapshot as live for as long as the API was gone.
  it('a failed poll outranks the last status that arrived', () => {
    expect(syncNotice(status('running'), true)).toEqual({ kind: 'unreachable' })
    expect(syncNotice(status('failed', 'boom'), true)).toEqual({ kind: 'unreachable' })
    expect(syncNotice(undefined, true)).toEqual({ kind: 'unreachable' })
  })

  it('only the deliberate state is muted', () => {
    expect(syncNoticeCopy({ kind: 'unreachable' }).tone).toBe('danger')
    expect(syncNoticeCopy({ kind: 'scheduler', state: 'failed', error: null }).tone).toBe('danger')
    expect(syncNoticeCopy({ kind: 'scheduler', state: 'retrying', error: null }).tone).toBe('danger')
    expect(syncNoticeCopy({ kind: 'scheduler', state: 'disabled', error: null }).tone).toBe('muted')
  })
})
