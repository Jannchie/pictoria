/**
 * 详情读模型里的打分器分数：只放行注册表（`SCORERS`）里还在的打分器。
 *
 * `post_aesthetic_scores` 是通用表，已退役打分器（`silva_luna`，2026-11）的行原样留在
 * 库里。读分数的查询按 `SCORERS` 的名字收窄 —— 漏了这一条，那些行就会原样漏进 API 的
 * `aestheticScores`，前端会给一个已经不存在的打分器画出分数。
 */
import type { SqliteHandle } from '../connection.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SCORERS } from '../scorers.js'
import { createTestDb } from '../testing.js'
import { fetchAestheticByIds, getDetail } from './post-detail.js'

let sqlite: SqliteHandle

beforeAll(() => {
  sqlite = createTestDb()
  const insPost = sqlite.prepare('INSERT INTO posts (id, file_path, file_name, extension) VALUES (?, \'dir\', ?, \'jpg\')')
  const insScore = sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, ?, ?)')
  for (const id of [1, 2, 3]) insPost.run(id, `f${id}`)
  // 1：在册的和退役的都有；2：只有退役的 / 不认识的；3：什么都没有
  insScore.run(1, 'silva', 0.5)
  insScore.run(1, 'silva_luna', 0.9)
  insScore.run(2, 'silva_luna', 0.8)
  insScore.run(2, 'some_other', 0.7)
})

afterAll(() => sqlite.close())

describe('fetchAestheticByIds', () => {
  it('只返回 SCORERS 里的打分器，已退役打分器的行被滤掉', () => {
    const got = fetchAestheticByIds(sqlite, [1, 2, 3])
    expect(got.get(1)).toEqual([{ scorer: 'silva', score: 0.5 }])
    // 只有非在册分数的 post 根本没有条目，而不是一个装着退役分数的数组
    expect(got.has(2)).toBe(false)
    expect(got.has(3)).toBe(false)

    const registered = new Set<string>(SCORERS.map(s => s.name))
    for (const scores of got.values())
      expect(scores.filter(s => !registered.has(s.scorer))).toEqual([])
  })

  it('空 id 列表是空结果', () => {
    expect(fetchAestheticByIds(sqlite, []).size).toBe(0)
  })
})

describe('getDetail', () => {
  it('aesthetic_scores 同样不带已退役打分器', () => {
    expect(getDetail(sqlite, 1, () => null)!.aesthetic_scores).toEqual([{ scorer: 'silva', score: 0.5 }])
    expect(getDetail(sqlite, 2, () => null)!.aesthetic_scores).toEqual([])
  })
})
