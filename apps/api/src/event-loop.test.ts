import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesceWithCooldown } from './event-loop.js'

describe('coalesceWithCooldown', () => {
  // 上传一批图时 embedding 每几十秒就清空一次。原来每次清空都 await 一次全库重建，
  // 实测 10 分钟跑了约 20 轮，每轮在主线程上占 10 s 以上的 CPU。
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('第一次请求立即跑', async () => {
    const run = vi.fn(async () => {})
    coalesceWithCooldown(run, 60_000)()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('冷却期内的请求合并成一次，等冷却期满再跑', async () => {
    const run = vi.fn(async () => {})
    const request = coalesceWithCooldown(run, 60_000)
    request()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      request()
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('冷却期从上一轮**结束**算 —— 慢的一轮不会被紧接着再来一轮', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>((r) => { finish = r }))
    const request = coalesceWithCooldown(run, 60_000)
    request()
    await vi.advanceTimersByTimeAsync(0)
    request()
    await vi.advanceTimersByTimeAsync(120_000) // 第一轮跑了 2 分钟
    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('跑着的时候来多少个请求，跑完都只补一次', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>((r) => { finish = r }))
    const request = coalesceWithCooldown(run, 1_000)
    request()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++)
      request()
    finish()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('没有新请求就不再跑', async () => {
    const run = vi.fn(async () => {})
    coalesceWithCooldown(run, 60_000)()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('一轮失败不影响后面的请求', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom')
    })
    const request = coalesceWithCooldown(run, 1_000)
    request()
    await vi.advanceTimersByTimeAsync(0)
    request()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
