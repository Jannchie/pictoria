/**
 * `callKeyed` 的 conflict 选择。
 *
 * 这一条守的是一个会**永久**卡死的形状：cairnq 的 `conflict: 'reuse'` 不看状态
 * （`store/base.js`：`if (conflict === "reuse") return rowToTask(current)`），于是
 * 一个 key 一旦指向终态失败的任务，`call()` 就会一直重抛它的 `TaskFailed`；而没人
 * 调 `purge()` 的话那行 key 连重启都活得下来。backfill 循环的 key 由
 * `ORDER BY p.id` 的待办集算出来，失败之后下一轮算出的是同一个 key —— 整条循环
 * 从此不再前进。
 */
import type { CairnQ, Task, TaskStatus } from 'cairnq'
import { describe, expect, it } from 'vitest'
import { callKeyed } from './tasks.js'

/** 只实现 `callKeyed` 会碰的两个方法，记下它最终选了哪个 conflict。 */
function fakeTasks(existingStatus: TaskStatus | null) {
  const seen: Array<Record<string, unknown>> = []
  const tasks = {
    getByKey: async () => (existingStatus === null ? null : ({ status: existingStatus } as Task)),
    call: async (_task: unknown, _payload: unknown, opts: Record<string, unknown>) => {
      seen.push(opts)
      return 'result'
    },
  } as unknown as CairnQ
  return { tasks, seen }
}

const anyTask = { name: 'x' } as never

async function conflictFor(status: TaskStatus | null, reuseSucceeded = false) {
  const { tasks, seen } = fakeTasks(status)
  await callKeyed(tasks, anyTask, {}, { key: 'k', reuseSucceeded })
  return seen[0]!.conflict
}

describe('callKeyed', () => {
  it('这个 key 还没有任务时用 reuse', async () => {
    expect(await conflictFor(null)).toBe('reuse')
  })

  // key 的本意就是这个：用户连点两下、防抖打出同一串 prompt，拿回同一个在跑的任务。
  it.each(['queued', 'running'] as const)('任务还在 %s 时复用它', async (status) => {
    expect(await conflictFor(status)).toBe('reuse')
  })

  // 核心：终态的一律换掉。失败的换掉才不会永久 500，成功的换掉才不会在图转过之后
  // 还回来转之前的标签。
  it.each(['failed', 'canceled', 'succeeded'] as const)('任务已 %s 时换成新任务', async (status) => {
    expect(await conflictFor(status)).toBe('replace')
  })

  // 输入全在 key 里的那种（文本 embedding 的 key 就是 prompt）才允许复用成功结果。
  it('reuseSucceeded 打开时复用成功的任务', async () => {
    expect(await conflictFor('succeeded', true)).toBe('reuse')
  })

  it('reuseSucceeded 打开也不复用失败的任务', async () => {
    expect(await conflictFor('failed', true)).toBe('replace')
  })

  it('reuseSucceeded 不会漏进提交参数', async () => {
    const { tasks, seen } = fakeTasks(null)
    await callKeyed(tasks, anyTask, {}, { key: 'k', reuseSucceeded: true, queue: 'gpu' })
    expect(seen[0]).toEqual({ key: 'k', queue: 'gpu', conflict: 'reuse' })
  })
})

/**
 * 同 key 的并发调用必须**合流**：检查（getByKey）和提交（call）隔着 await，裸写的
 * 话两个并发调用会双双看到同一个终态任务、双双选 replace —— 而 cairnq 的 replace
 * 会把对方刚建出来的新任务 cancel 掉，一边 `TaskCanceled` 500 加一次白烧的 GPU，
 * 恰好发生在 key 本该防住的那种双击上。
 */
describe('callKeyed 的进程内合流', () => {
  /** call 挂在 gate 上不返回，让两个调用真的并发在场。 */
  function slowTasks() {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const tasks = {
      getByKey: async () => ({ status: 'succeeded' } as Task),
      call: async () => {
        calls += 1
        await gate
        return `result-${calls}`
      },
    } as unknown as CairnQ
    return { tasks, release, calls: () => calls }
  }

  it('同 key 的第二个调用加入第一个，拿同一份结果', async () => {
    const { tasks, release, calls } = slowTasks()
    const p1 = callKeyed(tasks, anyTask, {}, { key: 'same' })
    const p2 = callKeyed(tasks, anyTask, {}, { key: 'same' })
    release()
    expect(await Promise.all([p1, p2])).toEqual(['result-1', 'result-1'])
    expect(calls()).toBe(1)
  })

  it('不同 key 不合流', async () => {
    const { tasks, release, calls } = slowTasks()
    const p1 = callKeyed(tasks, anyTask, {}, { key: 'a' })
    const p2 = callKeyed(tasks, anyTask, {}, { key: 'b' })
    release()
    await Promise.all([p1, p2])
    expect(calls()).toBe(2)
  })

  it('一轮结束后 key 释放，下一次照常提交', async () => {
    const { tasks, release, calls } = slowTasks()
    const p1 = callKeyed(tasks, anyTask, {}, { key: 'same' })
    release()
    await p1
    await callKeyed(tasks, anyTask, {}, { key: 'same' })
    expect(calls()).toBe(2)
  })
})
