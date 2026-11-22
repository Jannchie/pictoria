import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useTextField } from '@/composables/useTextField'

let scope: ReturnType<typeof effectScope> | null = null
afterEach(() => {
  scope?.stop()
  scope = null
})

/** A field over a fake post whose server value lives in `server`. */
function setup(opts: { ready?: boolean, fail?: boolean } = {}) {
  const postId = ref(1)
  const server = ref('old')
  const ready = ref(opts.ready ?? true)
  const commit = vi.fn(async (_id: number, _o: string, n: string) => {
    if (opts.fail) {
      throw new Error('nope')
    }
    server.value = n
  })
  const onError = vi.fn()
  scope = effectScope()
  const field = scope.run(() => useTextField({
    postId: () => postId.value,
    read: () => server.value,
    ready: () => ready.value,
    commit,
    onError,
  }))!
  return { postId, server, ready, commit, onError, field }
}

describe('usetextfield', () => {
  it('starts from the server value and follows it while not editing', async () => {
    const { server, field } = setup()
    expect(field.draft.value).toBe('old')
    server.value = 'undone'
    await nextTick()
    expect(field.draft.value).toBe('undone')
  })

  it('keeps the draft while editing', async () => {
    const { server, field } = setup()
    field.onFocus()
    field.draft.value = 'typing'
    server.value = 'elsewhere'
    await nextTick()
    expect(field.draft.value).toBe('typing')
  })

  it('commits a changed draft once, with the post id and both values', async () => {
    const { commit, field } = setup()
    field.onFocus()
    field.draft.value = 'new'
    await field.save()
    expect(commit).toHaveBeenCalledExactlyOnceWith(1, 'old', 'new')
    expect(field.invalid.value).toBe(false)
  })

  it('does not commit an unchanged draft or before the detail is in', async () => {
    const unchanged = setup()
    await unchanged.field.save()
    expect(unchanged.commit).not.toHaveBeenCalled()
    scope?.stop()

    const notReady = setup({ ready: false })
    notReady.field.draft.value = 'new'
    await notReady.field.save()
    expect(notReady.commit).not.toHaveBeenCalled()
  })

  it('on failure reports, rolls back and marks invalid; another post clears the mark', async () => {
    const { postId, onError, field } = setup({ fail: true })
    field.onFocus()
    field.draft.value = 'new'
    await field.save()
    expect(onError).toHaveBeenCalledOnce()
    expect(field.draft.value).toBe('old')
    expect(field.invalid.value).toBe(true)

    postId.value = 2
    await nextTick()
    expect(field.invalid.value).toBe(false)
  })

  it('a failure after switching posts leaves the new post\'s draft alone', async () => {
    const { postId, server, commit, field } = setup()
    commit.mockImplementationOnce(async () => {
      postId.value = 2
      server.value = 'second'
      await nextTick()
      throw new Error('late')
    })
    field.draft.value = 'new'
    await field.save()
    expect(field.draft.value).toBe('second')
    expect(field.invalid.value).toBe(false)
  })
})
