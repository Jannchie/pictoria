/**
 * `withTightPoll`：真实句柄的 `call` 默认带紧轮询；调用点给了 `pollMs` 就整组归它。
 */
import type { CairnQ, CallOptions } from 'cairnq'
import { expect, it } from 'vitest'
import { withTightPoll } from './tasks.js'

function recording() {
  const seen: Array<CallOptions | undefined> = []
  const tasks = { call: async (_t: unknown, _p?: unknown, opts?: CallOptions) => { seen.push(opts) } } as unknown as CairnQ
  return { tasks: withTightPoll(tasks), seen }
}

it('没给 pollMs：合并紧轮询，其余选项照传', async () => {
  const { tasks, seen } = recording()
  await tasks.call('x', {}, { queue: 'q', timeoutMs: 1000 })
  await tasks.call('x')
  expect(seen).toEqual([
    { pollMs: 20, maxPollMs: 50, queue: 'q', timeoutMs: 1000 },
    { pollMs: 20, maxPollMs: 50 },
  ])
})

it('给了 pollMs：原样传，不混入 maxPollMs', async () => {
  const { tasks, seen } = recording()
  await tasks.call('x', {}, { timeoutMs: 1000, pollMs: 500 })
  expect(seen).toEqual([{ timeoutMs: 1000, pollMs: 500 }])
})
