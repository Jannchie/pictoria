/**
 * `scores.ts` 的两个读函数。
 *
 * 这个模块**不**按 `SCORERS` 过滤 —— 它按调用方给的 scorer 名精确匹配。所以这里钉的是
 * 「按名隔离」：同一张图在库里留着已退役打分器（`silva_luna`）的行时，问 silva 不能把
 * 它带出来；而"不让退役名走到 API"是更上层（`post-detail.ts` 按 `SCORERS` 取名）的事。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'
import { getAestheticScore, scorerValuesFor } from './scores.js'

const { sqlite, cleanup } = createTempDb()
afterAll(cleanup)

function score(postId: number, scorer: string, value: number): void {
  sqlite.prepare(`INSERT INTO ${AESTHETIC_SCORES_TABLE} (post_id, scorer, score) VALUES (?, ?, ?)`).run(postId, scorer, value)
}

beforeAll(() => {
  for (const id of [1, 2, 3, 4]) insertPost(sqlite, { id })
  score(1, SILVA.name, 0.25)
  score(2, SILVA.name, 0.75)
  // post 3 只有退役打分器的行；post 1 两种都有、值不同。
  score(3, 'silva_luna', 0.9)
  score(1, 'silva_luna', 0.5)
})

describe('scorerValuesFor', () => {
  it('空 id 列表直接给空 Map', () => {
    expect(scorerValuesFor(sqlite, [], SILVA.name).size).toBe(0)
  })

  it('只返回有分的 id，缺分的不补默认值', () => {
    const got = scorerValuesFor(sqlite, [1, 2, 3, 4, 999], SILVA.name)
    expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, 0.25], [2, 0.75]])
  })

  it('按 scorer 名隔离：退役打分器的行不会混进 silva 的结果', () => {
    const got = scorerValuesFor(sqlite, [1, 3], SILVA.name)
    expect(got.get(1)).toBe(0.25)
    expect(got.has(3)).toBe(false)
  })

  it('重复 id 不重复计数', () => {
    expect(scorerValuesFor(sqlite, [2, 2, 2], SILVA.name)).toEqual(new Map([[2, 0.75]]))
  })
})

describe('getAestheticScore', () => {
  it('有分返回分', () => {
    expect(getAestheticScore(sqlite, 2, SILVA.name)).toBe(0.75)
  })

  it('没分（或 post 不存在）返回 null', () => {
    expect(getAestheticScore(sqlite, 4, SILVA.name)).toBeNull()
    expect(getAestheticScore(sqlite, 999, SILVA.name)).toBeNull()
  })

  it('只有退役打分器的行时，问 silva 得 null；同一张图两种都有时取 silva 的那一行', () => {
    expect(getAestheticScore(sqlite, 3, SILVA.name)).toBeNull()
    expect(getAestheticScore(sqlite, 1, SILVA.name)).toBe(0.25)
  })
})
