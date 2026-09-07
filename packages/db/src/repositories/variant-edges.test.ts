/**
 * 证据表的两条硬规则：一对只有一行，自动写入永不覆盖用户裁决。
 *
 * 第二条是这张表的立身之本。仲裁结果按对缓存，重建每次都会把新算的距离写回来 ——
 * 如果那次写入能盖掉用户点过的"不是同一张"，那么手动拆分的寿命就又回到了一次
 * 重建，正是 `post_group_overrides` 已经修过一遍的病。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { deleteManyReturningPaths } from './posts.js'
import {
  edgeKey,
  listEdgesFor,
  listUserVerdicts,
  orderPair,
  readEdgesByLeft,
  setUserVerdict,
  upsertAutoEdges,
} from './variant-edges.js'

let sqlite: Database.Database
let cleanup: () => void

beforeAll(() => {
  const temp = createTempDb('variant-edges')
  sqlite = temp.sqlite
  cleanup = temp.cleanup
})

afterAll(() => cleanup())

beforeEach(() => {
  sqlite.exec('DELETE FROM post_variant_edges')
  sqlite.exec('DELETE FROM posts')
  for (let id = 1; id <= 4; id++)
    insertPost(sqlite, { id })
})

function rawEdge(a: number, b: number) {
  return sqlite
    .prepare<[number, number], { siglip_dist: number | null, lpips_dist: number | null, user_verdict: string | null }>(
      'SELECT siglip_dist, lpips_dist, user_verdict FROM post_variant_edges WHERE post_a = ? AND post_b = ?',
    )
    .get(a, b)
}

describe('pair ordering', () => {
  it('normalises either direction to the same row', () => {
    expect(orderPair(7, 3)).toEqual([3, 7])
    expect(edgeKey(7, 3)).toBe(edgeKey(3, 7))
  })

  it('writes one row no matter which way round the pair arrives', () => {
    upsertAutoEdges(sqlite, [{ postA: 3, postB: 1, siglipDist: 0.04, lpipsDist: null }])
    upsertAutoEdges(sqlite, [{ postA: 1, postB: 3, siglipDist: 0.04, lpipsDist: 0.2 }])

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM post_variant_edges').get()).toEqual({ n: 1 })
    expect(rawEdge(1, 3)).toMatchObject({ siglip_dist: 0.04, lpips_dist: 0.2 })
  })

  it('ignores a self pair rather than violating the CHECK', () => {
    expect(upsertAutoEdges(sqlite, [{ postA: 2, postB: 2, siglipDist: 0, lpipsDist: 0 }])).toBe(0)
  })
})

describe('automatic writes', () => {
  it('fills in the arbitration verdict without losing the recall distance', () => {
    upsertAutoEdges(sqlite, [{ postA: 1, postB: 2, siglipDist: 0.03, lpipsDist: null }])
    upsertAutoEdges(sqlite, [{ postA: 1, postB: 2, siglipDist: null, lpipsDist: 0.31 }])

    expect(rawEdge(1, 2)).toMatchObject({ siglip_dist: 0.03, lpips_dist: 0.31 })
  })

  it('never overwrites a user verdict', () => {
    setUserVerdict(sqlite, 1, 2, 'different')

    const written = upsertAutoEdges(sqlite, [{ postA: 1, postB: 2, siglipDist: 0.01, lpipsDist: 0.05 }])

    // 这一对"看起来"极像 —— 距离 0.05 远在阈值之内 —— 但用户说过不是，所以整行不动。
    expect(written).toBe(1)
    expect(rawEdge(1, 2)).toMatchObject({ user_verdict: 'different', lpips_dist: null })
  })

  it('skips a pair whose post is already gone', () => {
    deleteManyReturningPaths(sqlite, [2])

    const written = upsertAutoEdges(sqlite, [
      { postA: 1, postB: 2, siglipDist: 0.02, lpipsDist: 0.1 },
      { postA: 1, postB: 3, siglipDist: 0.02, lpipsDist: 0.1 },
    ])

    // 被删的那一对静默跳过，而不是让外键异常回滚掉同一批里算好的另一对。
    expect(written).toBe(1)
    expect(rawEdge(1, 2)).toBeUndefined()
    expect(rawEdge(1, 3)).toBeDefined()
  })
})

describe('reads', () => {
  it('indexes by left id so a whole row of neighbours costs one query', () => {
    upsertAutoEdges(sqlite, [
      { postA: 1, postB: 2, siglipDist: 0.02, lpipsDist: 0.1 },
      { postA: 1, postB: 3, siglipDist: 0.03, lpipsDist: null },
      { postA: 2, postB: 4, siglipDist: 0.04, lpipsDist: 0.9 },
    ])

    const found = readEdgesByLeft(sqlite, [1])

    expect([...found.keys()].sort()).toEqual(['1:2', '1:3'])
    expect(found.get('1:2')).toMatchObject({ siglipDist: 0.02, lpipsDist: 0.1 })
  })

  it('finds a post on either side of the pair', () => {
    upsertAutoEdges(sqlite, [
      { postA: 1, postB: 3, siglipDist: 0.03, lpipsDist: null },
      { postA: 3, postB: 4, siglipDist: 0.05, lpipsDist: null },
    ])

    expect(listEdgesFor(sqlite, 3).map(e => edgeKey(e.postA, e.postB)).sort()).toEqual(['1:3', '3:4'])
  })

  it('lists only the pairs a human ruled on', () => {
    upsertAutoEdges(sqlite, [{ postA: 1, postB: 2, siglipDist: 0.02, lpipsDist: 0.1 }])
    setUserVerdict(sqlite, 3, 4, 'same')

    expect(listUserVerdicts(sqlite)).toEqual([{ postA: 3, postB: 4, verdict: 'same' }])
  })

  it('drops its rows when a post is deleted', () => {
    upsertAutoEdges(sqlite, [{ postA: 1, postB: 2, siglipDist: 0.02, lpipsDist: 0.1 }])

    deleteManyReturningPaths(sqlite, [1])

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM post_variant_edges').get()).toEqual({ n: 0 })
  })
})
