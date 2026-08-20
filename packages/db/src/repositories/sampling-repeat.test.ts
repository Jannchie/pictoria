/**
 * 重复测量通道 —— 唯一能量到标注噪声的东西。
 *
 * 到 2026-08-20，5339 个不同的对里只有 3 个被问过两次，于是「同一个人判两次会不会
 * 一致」根本没有数据。没有这个数就分不清模型是还没学会，还是已经顶到标签噪声的
 * 天花板 —— 而 close 采样恰好把 64% 的标签堆在人与模型一致率只有 50~53% 的区间里，
 * 那里最需要知道天花板在哪。
 *
 * 这里钉住四件事：谁有资格被重问、呈现顺序独立于第一次、「这是重复测量」由服务端
 * 推导而不是客户端上报、以及重问不消耗度数预算。
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { insertPairwise } from './annotations.js'
import { edgeKey, flipPair, isRepeatMeasurement, repeatSlots, Sampler } from './sampling.js'

let sqlite: import('better-sqlite3').Database
let cleanup: () => void

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('sampling-repeat'))
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) insertPost(sqlite, { id })
})

beforeEach(() => {
  sqlite.exec('DELETE FROM pairwise_annotations')
})

afterAll(() => cleanup())

/** 直接写行，好把 created_at 拨到过去 —— insertPairwise 只会写 now。 */
function judged(a: number, b: number, winner: string, daysAgo: number): void {
  sqlite
    .prepare(
      `INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id, created_at)
       VALUES (?, ?, 'overall', ?, 'overall-v1', 's', datetime('now', ?))`,
    )
    .run(a, b, winner, `-${daysAgo} days`)
}

const repeats = (count: number, dimension = 'overall') =>
  new Sampler(sqlite).sampleRepeats({ count, dimension })

it('太新的、已经重问过的、skip 的都不进池子', () => {
  judged(1, 2, 'a', 1) // 太新：还记得上次点了哪边
  judged(3, 4, 'a', 30) // 已经判过两次 —— 一对只重问一次
  judged(4, 3, 'b', 20) // 反向也算同一对
  judged(5, 6, 'skip', 30) // 跳过的没有判决可比
  judged(7, 8, 'b', 30) // 唯一合格的
  expect(repeats(10).map(p => edgeKey(...p))).toEqual(['7:8'])
})

it('维度隔离：别的维度判过的对不会窜进来', () => {
  judged(1, 2, 'a', 30)
  expect(repeats(5, 'finish')).toEqual([])
})

it('池子返回归一化的对，左右交给唯一的出口 flipPair 决定', () => {
  judged(2, 1, 'a', 30) // 第一次量时 2 在左
  expect(repeats(1)).toEqual([[1, 2]]) // 池子不带朝向
  const seen = new Set(Array.from({ length: 60 }, () => flipPair([1, 2]).join('-')))
  expect(seen, '重问的左右必须独立随机，否则量到的是位置记忆').toEqual(new Set(['1-2', '2-1']))
})

it('「这是重复测量」由服务端推导，客户端报什么都不算数', () => {
  judged(1, 2, 'a', 30)
  expect(isRepeatMeasurement(sqlite, { a: 2, b: 1, dimension: 'overall' })).toBe(true) // 无序
  expect(isRepeatMeasurement(sqlite, { a: 1, b: 2, dimension: 'finish' })).toBe(false) // 维度隔离
  expect(isRepeatMeasurement(sqlite, { a: 3, b: 4, dimension: 'overall' })).toBe(false) // 没判过

  // 客户端老老实实报 'close'，服务端照样改写成 'repeat'
  const id = insertPairwise(sqlite, {
    post_a: 2,
    post_b: 1,
    dimension: 'overall',
    winner: 'b',
    rubric_version: 'overall-v1',
    session_id: 's',
    strategy: 'close',
  })
  const strategy = sqlite
    .prepare<[number], { strategy: string | null }>('SELECT strategy FROM pairwise_annotations WHERE id = ?')
    .get(id)!.strategy
  expect(strategy).toBe('repeat')
})

it('冷却期内的第二次不算重复测量 —— 那量的是记忆不是判断', () => {
  judged(1, 2, 'a', 1)
  expect(isRepeatMeasurement(sqlite, { a: 1, b: 2, dimension: 'overall' })).toBe(false)
})

it('重问不消耗度数预算 —— 同一对量三次仍然只是一次比较', () => {
  judged(1, 2, 'a', 30)
  judged(1, 2, 'a', 20)
  judged(2, 1, 'b', 10)
  // judgedGraph 是私有的：度数若按行累加，post 1 会到 3 而触顶 CLOSE_PAIR_DEGREE，
  // 被逐出重访池 —— 一次比较量三遍不该有这个效果。
  const inner = new Sampler(sqlite) as unknown as {
    judgedGraph: (d: string) => { degreeOf: (p: number) => number, spent: (p: number) => boolean }
  }
  const graph = inner.judgedGraph('overall')
  expect(graph.degreeOf(1)).toBe(1)
  expect(graph.spent(1)).toBe(false)
})

it('repeatSlots 是伯努利抽样，均值贴着 share', () => {
  expect(repeatSlots(20, 0)).toBe(0)
  expect(repeatSlots(20, 1)).toBe(20)
  const total = Array.from({ length: 400 }, () => repeatSlots(20, 0.05)).reduce((a, b) => a + b, 0)
  // 期望 400 × 20 × 0.05 = 400，σ ≈ 19.5；±5σ 的区间，随机失败率可忽略
  expect(total).toBeGreaterThan(300)
  expect(total).toBeLessThan(500)
})
