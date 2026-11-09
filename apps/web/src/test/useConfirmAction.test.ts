import { describe, expect, it, vi } from 'vitest'
import { useConfirmAction } from '@/composables/useConfirmAction'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useconfirmaction', () => {
  it('starts closed', () => {
    const action = useConfirmAction<number[]>()
    expect(action.target.value).toBeNull()
    expect(action.isRunning.value).toBe(false)
  })

  it('request opens the confirmation; cancel closes it', () => {
    const action = useConfirmAction<number[]>()
    action.request([1, 2])
    expect(action.target.value).toEqual([1, 2])
    expect(action.isRunning.value).toBe(false)
    action.cancel()
    expect(action.target.value).toBeNull()
  })

  it('a second request while confirming does not replace the target', () => {
    const action = useConfirmAction<number[]>()
    action.request([1])
    action.request([2])
    expect(action.target.value).toEqual([1])
  })

  it('confirm runs the action on the snapshotted target and closes on success', async () => {
    const action = useConfirmAction<number[]>()
    const run = vi.fn(async () => {})
    const onError = vi.fn()
    action.request([3, 4])
    await expect(action.confirm({ run, onError })).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith([3, 4])
    expect(onError).not.toHaveBeenCalled()
    expect(action.target.value).toBeNull()
  })

  it('confirm is a no-op unless confirming', async () => {
    const action = useConfirmAction<number[]>()
    const run = vi.fn(async () => {})
    await expect(action.confirm({ run, onError: vi.fn() })).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('while running: cancel, request and a second confirm are all ignored', async () => {
    const action = useConfirmAction<number[]>()
    const gate = deferred()
    const run = vi.fn(() => gate.promise)
    action.request([1])
    const first = action.confirm({ run, onError: vi.fn() })
    expect(action.isRunning.value).toBe(true)
    expect(action.target.value).toEqual([1])

    action.cancel()
    action.request([9])
    await expect(action.confirm({ run, onError: vi.fn() })).resolves.toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(action.isRunning.value).toBe(true)
    expect(action.target.value).toEqual([1])

    gate.resolve()
    await expect(first).resolves.toBe(true)
    expect(action.target.value).toBeNull()
    expect(action.isRunning.value).toBe(false)
    // Closed again: a fresh request opens normally.
    action.request([9])
    expect(action.target.value).toEqual([9])
  })

  it('a failed run returns to confirming with the same target and reports the error', async () => {
    const action = useConfirmAction<{ path: string }>()
    const failure = new Error('boom')
    const onError = vi.fn()
    action.request({ path: 'a/b' })
    await expect(action.confirm({
      run: async () => {
        throw failure
      },
      onError,
    })).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith(failure, { path: 'a/b' })
    expect(action.target.value).toEqual({ path: 'a/b' })
    expect(action.isRunning.value).toBe(false)

    // The user can retry from there…
    await expect(action.confirm({ run: async () => {}, onError })).resolves.toBe(true)
    expect(action.target.value).toBeNull()
  })

  it('after a failure the user can still cancel', async () => {
    const action = useConfirmAction<number>()
    action.request(1)
    await action.confirm({
      run: async () => {
        throw new Error('x')
      },
      onError: () => {},
    })
    action.cancel()
    expect(action.target.value).toBeNull()
  })
})
