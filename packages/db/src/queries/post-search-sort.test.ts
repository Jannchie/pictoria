/**
 * 分数排序的分段计划（`buildScoreSortPlan`）与原单条 LEFT JOIN 查询（`buildSearchQuery`）对拍。
 *
 * 结果序、`sort_value`、offset 语义（包括跨过“有分数 / NULL 尾巴”分界的页）必须逐行一致；
 * 预算内凑不满时计划要交还（返回 null），而不是给出错的页。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SqliteHandle } from '../connection.js'
import { createTestDb } from '../testing.js'
import { buildScoreSortPlan, buildSearchQuery, runScoreSortPlan, searchPosts, type PostFilterWithOrder } from './post-search.js'

const N = 600
let sqlite: SqliteHandle

/** 确定性的伪随机，失败时可复现。 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

beforeAll(() => {
  sqlite = createTestDb()
  const r = rng(42)
  const insPost = sqlite.prepare(
    `INSERT INTO posts (id, file_path, file_name, extension, rating, score) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insAes = sqlite.prepare(`INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, ?, ?)`)
  const insWaifu = sqlite.prepare(`INSERT INTO post_waifu_scores (post_id, score) VALUES (?, ?)`)
  const insTag = sqlite.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`)
  const link = sqlite.prepare(`INSERT INTO post_has_tag (post_id, tag_name, is_auto) VALUES (?, ?, 0)`)
  sqlite.transaction(() => {
    for (const t of ['common', 'rare'])
      insTag.run(t)
    for (let id = 1; id <= N; id++) {
      // 分数取有限几个值，制造大量打平（检验 id 次序键）。
      const q = (x: number) => Math.round(x * 20) / 20
      insPost.run(id, `f${id % 3}`, `p${id}`, id % 7 ? 'png' : 'jpg', Math.floor(r() * 5), r() < 0.4 ? Math.floor(r() * 6) : 0)
      if (r() < 0.85)
        insAes.run(id, 'silva', q(r()))
      if (r() < 0.8)
        insAes.run(id, 'silva_luna', q(r()))
      if (r() < 0.75)
        insWaifu.run(id, q(r()) * 10)
      if (r() < 0.6)
        link.run(id, 'common')
      if (r() < 0.05)
        link.run(id, 'rare')
    }
    // 一部分做成近重复成员，默认被 onlyCanonical 滤掉。
    sqlite.prepare(`UPDATE posts SET canonical_post_id = id - 1 WHERE id % 11 = 0`).run()
  })()
})

afterAll(() => sqlite.close())

function oldQuery(f: PostFilterWithOrder, limit: number, offset: number) {
  const { sql, params } = buildSearchQuery(f, limit, offset)
  return sqlite.prepare<unknown[], Record<string, unknown>>(sql).all(...params)
    .map(r => [r.id, r._sort_col ?? null])
}

const ORDER_BYS = ['silva_score', 'silva_luna_score', 'waifu_score', 'discrepancy']
const FILTERS: PostFilterWithOrder[] = [
  {},
  { rating: [1, 2] },
  { tags: ['common'] },
  { tags: ['rare'] },
  { folder: 'f1' },
  { extension: ['jpg'] },
  { silvaScoreLevels: ['A', 'B'] },
  { silvaScoreLevels: ['UNSCORED'] },
  { silvaLunaScoreLevels: ['E', 'UNSCORED'] },
  { waifuScoreLevels: ['C'] },
  { waifuScoreRange: [2, 7] },
  { onlyCanonical: false },
  { score: [0, 5], tags: ['common'] },
]

describe('score sort plan vs the single LEFT JOIN query', () => {
  it('returns the same rows and sort values on every page', () => {
    let compared = 0
    for (const orderBy of ORDER_BYS) {
      for (const order of ['desc', 'asc'] as const) {
        for (const base of FILTERS) {
          const f = { ...base, orderBy, order }
          const all = oldQuery(f, N, 0)
          // 页宽 37 让页边界落在各种位置；最后一页之后再多翻一页（空页）。
          for (let offset = 0; offset <= all.length + 37; offset += 37) {
            const got = searchPosts(sqlite, f, { limit: 37, offset }).map(r => [r.id, r.sort_value])
            expect(got, `${JSON.stringify(f)} offset=${offset}`).toEqual(oldQuery(f, 37, offset))
            compared++
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500)
  })

  it('with a tiny budget either returns the exact page or hands back to the old query', () => {
    let exact = 0
    let handedBack = 0
    for (const orderBy of ['silva_score', 'silva_luna_score', 'waifu_score']) {
      for (const base of FILTERS) {
        const f = { ...base, orderBy, order: 'desc' as const }
        const plan = buildScoreSortPlan(f)!
        for (const offset of [0, 20, 200]) {
          for (const budget of [5, 50, 300]) {
            const got = runScoreSortPlan(sqlite, plan, 20, offset, budget)
            if (got === null) {
              handedBack++
              continue
            }
            exact++
            expect(got.map(r => [r.id, r._sort_col ?? null]), `${JSON.stringify(f)} offset=${offset} budget=${budget}`)
              .toEqual(oldQuery(f, 20, offset))
          }
        }
      }
    }
    // 两条路都要真的走到，否则这个测试什么也没证明。
    expect(exact).toBeGreaterThan(0)
    expect(handedBack).toBeGreaterThan(0)
  })

  it('is not used for random order, lab, or non-score columns', () => {
    expect(buildScoreSortPlan({ orderBy: 'silva_score', order: 'random' })).toBeNull()
    expect(buildScoreSortPlan({ orderBy: 'silva_score', lab: [50, 0, 0] })).toBeNull()
    expect(buildScoreSortPlan({ orderBy: 'created_at', order: 'desc' })).toBeNull()
  })
})
