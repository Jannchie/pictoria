/**
 * 扩充的三条不变量：原始标注必须原样在场、替身必须来自同一组、变体不能自相矛盾。
 *
 * 最要紧的是每条输出都带 `annotationId`。少了它，使用方就没法按标注分组划分数据集，
 * 而同一条标注的变体一旦分落训练与验证两侧，验证指标就是在考模型"背没背过这张图"。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { expandListwiseAnnotations, pickCombinations } from './listwise-expand.js'
import { upsertAutoEdges } from './variant-edges.js'

let sqlite: Database.Database
let cleanup: () => void

beforeAll(() => {
  const temp = createTempDb('listwise-expand')
  sqlite = temp.sqlite
  cleanup = temp.cleanup
})

afterAll(() => cleanup())

beforeEach(() => {
  sqlite.exec('DELETE FROM listwise_annotations')
  sqlite.exec('DELETE FROM post_variant_edges')
  sqlite.exec('DELETE FROM posts')
})

/** `head` 带着 `members` 成一组，并给出组内边（决定替身顺序）。 */
function group(head: number, members: number[], lpips: number[] = []) {
  insertPost(sqlite, { id: head })
  for (const [i, m] of members.entries()) {
    insertPost(sqlite, { id: m })
    sqlite.prepare('UPDATE posts SET canonical_post_id = ? WHERE id = ?').run(head, m)
    upsertAutoEdges(sqlite, [{ postA: head, postB: m, siglipDist: 0.02, lpipsDist: lpips[i] ?? 0.1 }])
  }
}

function annotate(ranking: number[]) {
  sqlite
    .prepare(
      'INSERT INTO listwise_annotations (post_ids, ranking, dimension, rubric_version, session_id)'
      + " VALUES (?, ?, 'overall', 'overall-v1', 's')",
    )
    .run(JSON.stringify(ranking), JSON.stringify(ranking))
}

describe('pickCombinations', () => {
  it('starts from the untouched original', () => {
    expect(pickCombinations([3, 3], 4)[0]).toEqual([0, 0])
  })

  it('spreads variation across slots instead of piling it on one', () => {
    const combos = pickCombinations([3, 3, 3], 6)

    // 按字典序取前 N 会让前两位永远是 0；均匀取样必须让每个位置都动过。
    for (let slot = 0; slot < 3; slot++)
      expect(combos.some(c => c[slot] !== 0)).toBe(true)
  })

  it('never exceeds the real number of combinations', () => {
    expect(pickCombinations([2, 1], 99)).toHaveLength(2)
  })

  it('returns nothing for an empty ranking', () => {
    expect(pickCombinations([], 8)).toEqual([])
  })
})

describe('expandListwiseAnnotations', () => {
  it('keeps the original annotation as variant 0', () => {
    group(1, [2])
    insertPost(sqlite, { id: 9 })
    annotate([1, 9])

    const rows = expandListwiseAnnotations(sqlite)

    expect(rows[0]).toMatchObject({ annotationId: 1, variant: 0, ranking: [1, 9], substitutions: [] })
  })

  it('substitutes only within the same variant group', () => {
    group(1, [2, 3])
    insertPost(sqlite, { id: 9 }) // 独立图，没有替身
    annotate([1, 9])

    const rows = expandListwiseAnnotations(sqlite)

    for (const row of rows) {
      expect([1, 2, 3]).toContain(row.ranking[0])
      expect(row.ranking[1]).toBe(9) // 没有组的位置永远是它自己
    }
    expect(rows.length).toBeGreaterThan(1)
  })

  it('preserves rank order and length', () => {
    group(1, [2])
    group(5, [6])
    annotate([1, 5])

    for (const row of expandListwiseAnnotations(sqlite)) {
      expect(row.ranking).toHaveLength(2)
      // 第一位来自第一组，第二位来自第二组 —— 名次没有被打乱。
      expect([1, 2]).toContain(row.ranking[0])
      expect([5, 6]).toContain(row.ranking[1])
    }
  })

  it('carries the source annotation id on every variant', () => {
    group(1, [2, 3])
    group(5, [6])
    annotate([1, 5])

    const rows = expandListwiseAnnotations(sqlite)

    // 这是防泄漏的唯一抓手：使用方按它分组划分。
    expect(new Set(rows.map(r => r.annotationId))).toEqual(new Set([1]))
    expect(rows.length).toBeGreaterThan(1)
  })

  it('prefers the closest substitute when a slot is capped', () => {
    group(1, [2, 3], [0.35, 0.05]) // #3 更像 #1
    annotate([1])

    const rows = expandListwiseAnnotations(sqlite, { maxCandidatesPerSlot: 2 })

    expect(rows.map(r => r.ranking[0])).toEqual([1, 3])
    expect(rows[1]!.substitutions).toEqual([{ from: 1, to: 3, lpips: 0.05 }])
  })

  it('honours maxLpips by dropping loose substitutes', () => {
    group(1, [2], [0.4])
    annotate([1])

    expect(expandListwiseAnnotations(sqlite, { maxLpips: 0.2 })).toHaveLength(1)
    expect(expandListwiseAnnotations(sqlite, { maxLpips: 0.5 }).length).toBeGreaterThan(1)
  })

  it('drops a variant where two slots picked the same image', () => {
    // 一条排序里同一张图出现两次不是有效样本。
    group(1, [2])
    insertPost(sqlite, { id: 3 })
    sqlite.prepare('UPDATE posts SET canonical_post_id = 1 WHERE id = 3').run()
    annotate([2, 3]) // 两个位置属于同一组，替身会撞车

    for (const row of expandListwiseAnnotations(sqlite))
      expect(new Set(row.ranking).size).toBe(row.ranking.length)
  })

  it('never silently drops the human original, even a malformed one', () => {
    // 两个位置是同一张图 —— 数据本身有问题，但它是人给的，交出去让使用方判断。
    insertPost(sqlite, { id: 1 })
    insertPost(sqlite, { id: 2 })
    annotate([1, 1])

    const rows = expandListwiseAnnotations(sqlite)

    expect(rows.filter(r => r.variant === 0)).toHaveLength(1)
    expect(rows[0]!.ranking).toEqual([1, 1])
  })

  it('skips an annotation whose ranking is empty', () => {
    // 生产库里真有一条（#142：post_ids 八张，ranking 为空）。没有名次就没有样本。
    insertPost(sqlite, { id: 1 })
    sqlite
      .prepare(
        'INSERT INTO listwise_annotations (post_ids, ranking, dimension, rubric_version, session_id)'
        + " VALUES ('[1]', '[]', 'overall', 'overall-v1', 's')",
      )
      .run()

    expect(expandListwiseAnnotations(sqlite)).toEqual([])
  })

  it('collapses to the originals when substitution is switched off', () => {
    group(1, [2, 3])
    annotate([1])

    expect(expandListwiseAnnotations(sqlite, { maxCandidatesPerSlot: 1 })).toHaveLength(1)
  })

  it('is deterministic', () => {
    group(1, [2, 3])
    group(5, [6])
    annotate([1, 5])

    expect(expandListwiseAnnotations(sqlite)).toEqual(expandListwiseAnnotations(sqlite))
  })
})
