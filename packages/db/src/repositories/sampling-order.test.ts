/**
 * 呈现顺序与采样来源 —— 两条让标注可分析的护栏。
 *
 * 1. 对内左右必须随机。pairByScoreBand 是 `out.push([a.id, b.id])` 且 `a.score <= b.score`，
 *    而 UI 恒定把 post_a 画在左边，于是 similar 抽出的对里屏幕左侧系统性站着旧分更低的
 *    那张。实测到 2026-08-20：mean(silva_a − silva_b) = −0.0153，z = −10.5，位置与内容
 *    从此不可分，左右偏好再也测不干净。
 * 2. 对与对之间的次序不能动。interleaveWithBridges 保证每个前缀都连通，sample-pairwise
 *    路由按 `pairs` 重建批次 —— 打乱列表会静默地把连通性切断。
 * 3. strategy 必须落到事件行上，否则 close（训练燃料）与 random/similar（模型无关、可作
 *    留出评估）事后无法区分。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTempDb, insertPost, insertVector, unitBlob } from '../__fixtures__/testdb.js'
import { insertPairwise } from './annotations.js'
import { Sampler } from './sampling.js'

let sqlite: import('better-sqlite3').Database
let cleanup: () => void

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('sampling-order'))
  // 只有两张图 → similar 只可能配出这一对，于是「谁在左边」是唯一的自由度。
  // 星级 3 与 4 在 SIMILAR_SCORE_BAND(=1) 内；tilt 拉开余弦，避开近重复的硬停
  // (MAX_PAIR_COSINE=0.94) 又不至于近到 SIMILAR_MIN_DISTANCE(=0.04) 以下。
  insertPost(sqlite, { id: 1, score: 3 })
  insertVector(sqlite, 1, unitBlob(1, 0))
  insertPost(sqlite, { id: 2, score: 4 })
  insertVector(sqlite, 2, unitBlob(1, 0.6))
})

afterAll(() => cleanup())

it('similar 抽出的对，左右是随机的（不再是旧分低的恒在左）', () => {
  const orientations = new Set<string>()
  let drawn = 0
  for (let i = 0; i < 80; i++) {
    for (const [a, b] of new Sampler(sqlite).samplePairs({ count: 1, strategy: 'similar' })) {
      expect(new Set([a, b])).toEqual(new Set([1, 2])) // 成员不受影响
      orientations.add(`${a}-${b}`)
      drawn++
    }
  }
  expect(drawn, '这个 fixture 应该能稳定抽出对；抽不出说明 KNN/档位阈值挡住了').toBeGreaterThan(20)
  expect(orientations, '左右没有随机化：旧分低的那张永远是 post_a').toEqual(new Set(['1-2', '2-1']))
})

it('random 策略下成员与数量不受翻转影响', () => {
  for (let i = 0; i < 20; i++)
    for (const [a, b] of new Sampler(sqlite).samplePairs({ count: 1, strategy: 'random' }))
      expect(new Set([a, b])).toEqual(new Set([1, 2]))
})

it('strategy 落到事件行上，且 NULL 表示来源未知', () => {
  const withStrategy = insertPairwise(sqlite, {
    post_a: 1,
    post_b: 2,
    dimension: 'overall',
    winner: 'a',
    rubric_version: 'overall-v1',
    session_id: 's',
    strategy: 'close',
  })
  const legacy = insertPairwise(sqlite, {
    post_a: 2,
    post_b: 1,
    dimension: 'overall',
    winner: 'b',
    rubric_version: 'overall-v1',
    session_id: 's',
  })
  const read = (id: number) => sqlite
    .prepare<[number], { strategy: string | null }>('SELECT strategy FROM pairwise_annotations WHERE id = ?')
    .get(id)!.strategy
  expect(read(withStrategy)).toBe('close')
  expect(read(legacy)).toBeNull()
})
