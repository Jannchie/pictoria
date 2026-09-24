import type { PendingCounter } from './queue-status.js'
import { describe, expect, it } from 'vitest'
import { LoopTracker } from './queue-status.js'

/**
 * 一个可手动推进的时钟，外加一个会记下被调用次数的计数函数。默认一块数完整个积压
 * （分块本身由 `packages/db` 的测试覆盖）；`counter` 可以换成别的。
 */
function setup(pending: number, counter?: PendingCounter) {
  let now = 1_000_000
  const state = { pending, calls: 0 }
  const tracker = new LoopTracker('tagger', 'gpu', counter ?? (() => {
    state.calls += 1
    return [state.pending]
  }), () => now)
  const advance = (ms: number) => {
    now += ms
  }
  /** 一批：开始、过 `ms` 毫秒、落库 `done` 条。 */
  const batch = (ms: number, done: number, failed = 0) => {
    tracker.begin()
    advance(ms)
    tracker.record(done, failed)
    state.pending = Math.max(0, state.pending - done - failed)
  }
  /** 取快照；若因此排了后台计数，等它落定再取一次。 */
  const snap = async () => {
    tracker.snapshot()
    await tracker.settled()
    return tracker.snapshot()
  }
  return { tracker, state, advance, batch, snap }
}

describe('loopTracker', () => {
  it('扫空时剩余是 0，而且不去数', async () => {
    const { tracker, state, snap } = setup(500)
    tracker.idle()
    const s = await snap()
    expect(s).toMatchObject({ state: 'idle', remaining: 0, etaSeconds: null })
    expect(state.calls).toBe(0)
  })

  it('快照从不等计数：刚开始忙时剩余是 null，数完才有值', async () => {
    const { tracker, batch } = setup(100)
    batch(1000, 10)
    expect(tracker.snapshot().remaining).toBeNull()
    await tracker.settled()
    expect(tracker.snapshot().remaining).toBe(90)
  })

  it('扫空之后的第一批立刻重数，不沿用"精确的 0"', async () => {
    const { tracker, state, batch, snap } = setup(100)
    tracker.idle()
    await snap()
    batch(1000, 10)
    expect((await snap()).remaining).toBe(90)
    expect(state.calls).toBe(1)
  })

  it('限频期内不重数，用落库条数递减', async () => {
    const { state, batch, snap } = setup(100)
    batch(1000, 10)
    expect((await snap()).remaining).toBe(90)
    batch(1000, 10, 2)
    expect((await snap()).remaining).toBe(78)
    expect(state.calls).toBe(1)
  })

  it('过了限频间隔再数一次，纠正估计', async () => {
    const { state, batch, advance, snap } = setup(100)
    batch(1000, 10)
    await snap()
    state.pending += 50 // 期间导入了新图，递减估计看不到
    advance(21_000)
    expect((await snap()).remaining).toBe(140)
    expect(state.calls).toBe(2)
  })

  it('速度 = 窗口内条数 ÷ 墙钟跨度，剩余时间 = 剩余 ÷ 速度', async () => {
    const { batch, advance, snap } = setup(100)
    batch(5000, 10)
    advance(5000) // 等卡的空隙也算进墙钟
    batch(5000, 10)
    const s = await snap()
    expect(s.ratePerSecond).toBeCloseTo(20 / 15)
    expect(s.etaSeconds).toBe(Math.round(80 / (20 / 15)))
    expect(s.sessionDone).toBe(20)
  })

  it('一批没推进（0 条）也是忙，不是扫空', async () => {
    const { batch, snap } = setup(100)
    batch(1000, 0)
    expect(await snap()).toMatchObject({ state: 'working', remaining: 100 })
  })

  it('扫空清掉这一段的进度和速度窗口', async () => {
    const { tracker, batch, snap } = setup(100)
    batch(1000, 10)
    tracker.idle()
    const s = await snap()
    expect(s).toMatchObject({ sessionDone: 0, ratePerSecond: null, processed: 10 })
  })

  it('出错记下错误；下一批成功就清掉', async () => {
    const { tracker, batch, snap } = setup(100)
    tracker.begin()
    tracker.error(new Error('boom'))
    expect(await snap()).toMatchObject({ state: 'error', lastError: 'Error: boom', batchStartedAt: null })
    batch(1000, 5)
    expect(await snap()).toMatchObject({ state: 'working', lastError: null })
  })

  it('计数抛错时沿用上一次的估计', async () => {
    let fail = false
    const { batch, advance, snap } = setup(0, () => {
      if (fail)
        throw new Error('locked')
      return [50]
    })
    batch(1000, 10)
    expect((await snap()).remaining).toBe(50)
    fail = true
    advance(60_000)
    expect((await snap()).remaining).toBe(50)
  })

  it('逐块累加；计数开始前落库的条数不再减', async () => {
    const { tracker, batch, snap } = setup(0, () => [7, 7, 7])
    batch(1000, 1)
    expect(tracker.snapshot().remaining).toBeNull()
    expect((await snap()).remaining).toBe(21)
  })

  it('计数途中转入扫空，数出来的过期积压不写回', async () => {
    const { tracker, batch } = setup(1000)
    batch(1000, 1)
    tracker.snapshot()
    tracker.idle()
    await tracker.settled()
    expect(tracker.snapshot().remaining).toBe(0)
  })

  it('几条循环同时到点，计数串行：一条数完才轮到下一条', async () => {
    const order: string[] = []
    const counter = (name: string): PendingCounter => function* () {
      order.push(`${name}1`)
      yield 1
      order.push(`${name}2`)
      yield 1
    }
    const a = setup(0, counter('a'))
    const b = setup(0, counter('b'))
    a.batch(1000, 1)
    b.batch(1000, 1)
    a.tracker.snapshot()
    b.tracker.snapshot()
    await b.tracker.settled()
    expect(order).toEqual(['a1', 'a2', 'b1', 'b2'])
  })
})
