/**
 * 用户的手动分组决定必须活过下一次重建。
 *
 * 这是 `post_group_overrides`（migration 0018）存在的全部理由：分组只有"全量重建"
 * 一条路，而重建清空全部 canonical 指针再重算。在这张表之前，"拆开"和"设为封面"
 * 的寿命是到下一次 embedding 回填排空为止 —— 几分钟，而且没有任何提示。
 *
 * 所以这里钉的不是"clearCanonical 写没写指针"，而是**拆完再重建一次，它还独立吗**。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { assignFromEdges, replaceAllGroups } from './dedup.js'
import {
  clearCanonical,
  deleteManyReturningPaths,
  listGroupOverrides,
  makeCanonical,
} from './posts.js'

let sqlite: Database.Database
let cleanup: () => void

function canonicalOf(id: number): number | null {
  return sqlite
    .prepare<[number], { canonical_post_id: number | null }>(
      'SELECT canonical_post_id FROM posts WHERE id = ?',
    )
    .get(id)!.canonical_post_id
}

function overrideOf(id: number): string | null {
  return sqlite
    .prepare<[number], { kind: string }>(
      'SELECT kind FROM post_group_overrides WHERE post_id = ?',
    )
    .get(id)?.kind ?? null
}

/** 一次"新图进来触发重建"：同一批边，加上库里当前的 override。 */
function rebuild(edges: Array<[number, number]>): void {
  const overrides = listGroupOverrides(sqlite)
  const assignments = assignFromEdges(
    edges.map(([a, b]) => ({ a, b, strength: 1 })),
    { excluded: overrides.standalone, pinned: overrides.canonical },
  )
  replaceAllGroups(sqlite, assignments)
}

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('overrides'))
})

afterAll(() => cleanup())

beforeEach(() => {
  // post_group_overrides 挂 FK 到 posts，删 posts 就跟着走
  sqlite.exec('DELETE FROM posts')
})

describe('ungroup（拆组）', () => {
  it('拆完写下 standalone，重建之后仍然独立', () => {
    for (const id of [1, 2, 3]) insertPost(sqlite, { id })
    rebuild([[1, 2], [1, 3]])
    expect([canonicalOf(2), canonicalOf(3)]).toEqual([1, 1])

    clearCanonical(sqlite, [3])
    expect(canonicalOf(3)).toBeNull()
    expect(overrideOf(3)).toBe('standalone')

    // 关键的一步：同样的边再算一次。没有 override 的话 3 会被原样合回去。
    rebuild([[1, 2], [1, 3]])
    expect(canonicalOf(3)).toBeNull()
    expect(canonicalOf(2)).toBe(1)
  })

  it('拆出来的 post 不当桥 —— 不会把它两边的图串到一起', () => {
    for (const id of [1, 2, 3]) insertPost(sqlite, { id })
    clearCanonical(sqlite, [2])
    rebuild([[1, 2], [2, 3]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([null, null, null])
  })

  it('落库和计算之间拆的那一下也算数（事务内重读 override）', () => {
    for (const id of [1, 2]) insertPost(sqlite, { id })
    // assignments 是几十秒前的 GPU 结果，那时 2 还没被拆；用户在计算期间拆了它。
    clearCanonical(sqlite, [2])
    replaceAllGroups(sqlite, [[2, 1]])
    expect(canonicalOf(2)).toBeNull()
  })

  it('之前钉过封面的 post 被拆出来时，意图跟着改成 standalone', () => {
    for (const id of [1, 2]) insertPost(sqlite, { id })
    rebuild([[1, 2]])
    makeCanonical(sqlite, 2)
    expect(overrideOf(2)).toBe('canonical')

    clearCanonical(sqlite, [2])
    expect(overrideOf(2)).toBe('standalone')
  })

  it('已经不存在的 id 照旧是空操作，不会被外键顶回来', () => {
    insertPost(sqlite, { id: 1 })
    expect(() => clearCanonical(sqlite, [1, 999])).not.toThrow()
    expect(overrideOf(999)).toBeNull()
  })
})

describe('make-canonical（钉封面）', () => {
  it('钉完写下 canonical，重建之后仍然是封面', () => {
    for (const id of [1, 2, 3]) insertPost(sqlite, { id })
    rebuild([[1, 2], [1, 3]])
    expect(canonicalOf(3)).toBe(1)

    expect(makeCanonical(sqlite, 3)).toBe(true)
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([3, 3, null])
    expect(overrideOf(3)).toBe('canonical')

    // 没有 override 的话，重建会按"组内最小 id"把封面还给 1
    rebuild([[1, 2], [1, 3]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([3, 3, null])
  })

  it('一个组只留一个 pin —— 改钉别人时旧的那条被清掉', () => {
    for (const id of [1, 2, 3]) insertPost(sqlite, { id })
    rebuild([[1, 2], [1, 3]])
    makeCanonical(sqlite, 3)
    makeCanonical(sqlite, 2)

    expect(overrideOf(2)).toBe('canonical')
    expect(overrideOf(3)).toBeNull()
    // 留着旧 pin 的话，重建要在两个 pinned 之间按 min id 二选一，
    // 选中的会是 2 而不是用户最后点的那个 —— 这里两者恰好都是 2，
    // 所以真正被钉住的是"3 的那条已经不在了"。
    rebuild([[1, 2], [1, 3]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([2, null, 2])
  })

  it('不在组里的 post 是空操作，也不留下 pin', () => {
    insertPost(sqlite, { id: 1 })
    expect(makeCanonical(sqlite, 1)).toBe(false)
    expect(overrideOf(1)).toBeNull()
  })
})

describe('override 的生命周期', () => {
  it('listGroupOverrides 按 kind 分两拨', () => {
    for (const id of [1, 2, 3]) insertPost(sqlite, { id })
    rebuild([[1, 2]])
    clearCanonical(sqlite, [3])
    makeCanonical(sqlite, 2)

    const { standalone, canonical } = listGroupOverrides(sqlite)
    expect([...standalone]).toEqual([3])
    expect([...canonical]).toEqual([2])
  })

  it('post 被删时 override 行跟着 FK 级联走', () => {
    for (const id of [1, 2]) insertPost(sqlite, { id })
    rebuild([[1, 2]])
    makeCanonical(sqlite, 2)
    clearCanonical(sqlite, [1])
    expect(sqlite.prepare<[], { n: number }>('SELECT count(*) n FROM post_group_overrides').get()!.n)
      .toBe(2)

    deleteManyReturningPaths(sqlite, [1, 2])
    expect(sqlite.prepare<[], { n: number }>('SELECT count(*) n FROM post_group_overrides').get()!.n)
      .toBe(0)
  })
})
