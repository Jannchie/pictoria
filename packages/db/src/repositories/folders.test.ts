/**
 * `folderScoreAggregates` 的 SQL 由 `SCORERS` 生成之后，必须和改写前的手写版本
 * 等价 —— 这是 `/v2/folders` 的热查询（docs/optimization-audit.md B1），形状变了
 * 就是性能回退。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from '../testing.js'
import { SILVA } from '../scorers.js'
import { addAgg, emptyAgg, folderScoreAggregates, folderScoreAggregatesSql } from './folders.js'

/**
 * 改写前手写的那条 SQL，逐字冻结；改动只有两处：join 别名 `a` 换成了注册表的别名
 * `pas_silva`（别名不影响查询计划），以及 `silva_luna` 退役（2026-11）时删掉了它那
 * 两列和一条 join。
 */
const LEGACY_SQL = `SELECT
  p.file_path                                          AS file_path,
  count(*)                                             AS posts,
  sum(CASE WHEN p.score > 0 THEN 1 ELSE 0 END)         AS scored,
  sum(CASE WHEN p.score > 0 THEN p.score ELSE 0 END)   AS score_total,
  sum(p.rating)                                        AS rating_total,
  sum(COALESCE(pas_silva.score, 0))                            AS silva_total,
  sum(CASE WHEN pas_silva.score IS NOT NULL THEN 1 ELSE 0 END) AS silva_n
FROM posts p
LEFT JOIN post_aesthetic_scores pas_silva ON pas_silva.post_id = p.id AND pas_silva.scorer = 'silva'
GROUP BY p.file_path`

/** 空白归一：多个空白压成一个，逗号前后的空白去掉。 */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim()
}

let sqlite: Database.Database

beforeAll(() => {
  sqlite = createTestDb()

  const insertPost = sqlite.prepare(
    'INSERT INTO posts (id, file_path, file_name, extension, width, height, score, rating) VALUES (?, ?, ?, \'jpg\', 100, 100, ?, ?)',
  )
  const insertScore = sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, ?, ?)')
  const posts: Array<[number, string, number, number]> = [
    [1, '.', 0, 0],
    [2, '.', 3, 1],
    [3, 'a', 5, 2],
    [4, 'a', 0, 3],
    [5, 'a/b', 4, 0],
    [6, 'c', 0, 0],
  ]
  for (const [id, dir, score, rating] of posts) insertPost.run(id, dir, `${id}.jpg`, score, rating)
  for (const [id, scorer, score] of [
    [1, 'silva', 0.5],
    [2, 'silva', 0.25],
    [2, 'silva_luna', 0.75],
    [3, 'silva_luna', 0.1],
    [5, 'silva', 0.9],
    [5, 'silva_luna', 0.3],
    // 不在注册表里的打分器（上面的 `silva_luna` 是已退役的，真实库里还留着它的行）
    // 的分不该混进来
    [6, 'some_other', 0.99],
  ] as const) insertScore.run(id, scorer, score)
})

afterAll(() => {
  sqlite.close()
})

describe('folderScoreAggregatesSql', () => {
  it('与改写前的手写 SQL 文本等价（空白归一后）', () => {
    expect(normalize(folderScoreAggregatesSql())).toBe(normalize(LEGACY_SQL))
  })

  it('查询计划与手写 SQL 相同', () => {
    const plan = (sql: string) =>
      sqlite.prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail)
    expect(plan(folderScoreAggregatesSql())).toEqual(plan(LEGACY_SQL))
  })

  it('结果与手写 SQL 相同', () => {
    const run = (sql: string) => sqlite.prepare(sql).all()
    expect(run(folderScoreAggregatesSql())).toEqual(run(LEGACY_SQL))
  })
})

describe('folderScoreAggregates', () => {
  it('按目录汇总，每个打分器各自计数', () => {
    const aggs = folderScoreAggregates(sqlite)
    expect(aggs.get('.')).toEqual({
      posts: 2,
      scored: 1,
      scoreTotal: 3,
      ratingTotal: 1,
      scorers: { [SILVA.name]: { total: 0.75, n: 2 } },
    })
    expect(aggs.get('c')!.scorers).toEqual({ silva: { total: 0, n: 0 } })
  })

  // 同一张表里住着别的 scorer 的行（已退役的 `silva_luna`、随便什么 `some_other`）：
  // 既不能出现在结果的键里，也不能混进 silva 的合计。
  it('不在 SCORERS 里的打分器不产生字段，也不混进 silva', () => {
    const aggs = folderScoreAggregates(sqlite)
    for (const agg of aggs.values()) expect(Object.keys(agg.scorers)).toEqual(['silva'])
    // 目录 a：post 3 只有 silva_luna 分，post 4 什么都没有
    expect(aggs.get('a')!.scorers.silva).toEqual({ total: 0, n: 0 })
    // 目录 a/b：post 5 两个 scorer 都有分，只算 silva 的 0.9
    expect(aggs.get('a/b')!.scorers.silva).toEqual({ total: 0.9, n: 1 })
  })

  it('addAgg 逐项累加，不共享嵌套对象', () => {
    const aggs = folderScoreAggregates(sqlite)
    const total = emptyAgg()
    for (const a of aggs.values()) addAgg(total, a)
    expect(total.posts).toBe(6)
    expect(total.scorers.silva).toEqual({ total: 0.5 + 0.25 + 0.9, n: 3 })
    // 累加不能改到源
    expect(aggs.get('.')!.scorers.silva.n).toBe(2)
  })
})
