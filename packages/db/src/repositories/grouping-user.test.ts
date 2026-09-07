/**
 * 用户手动合并 / 拆分差分组 —— `groupTogether` 与 `markDifferent`。
 *
 * 这两个函数各自都写**两处**状态：立刻可见的 `posts.canonical_post_id`，以及活过
 * 下一次重建的证据（`post_variant_edges.user_verdict` / `post_group_overrides`）。
 * 只写一处的实现在手点一次时看起来完全正常，几分钟后重建把它抹掉 —— 所以每个用例
 * 都同时钉住两处。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { assignFromEdges } from './dedup.js'
import { bulkUpdateField, clearCanonical, groupTogether, listGroupOverrides, markDifferent, updateField } from './posts.js'
import { listEdgesFor, listUserVerdicts } from './variant-edges.js'

const { sqlite, cleanup } = createTempDb('grouping-user')
afterAll(cleanup)

/** 某个 post 当前的组指针（NULL = 它自己是封面 / 独立）。 */
function canonicalOf(id: number): number | null {
  return sqlite
    .prepare<[number], { canonical_post_id: number | null }>(
      'SELECT canonical_post_id FROM posts WHERE id = ?',
    )
    .get(id)!.canonical_post_id
}

function overrideOf(id: number): string | null {
  const row = sqlite
    .prepare<[number], { kind: string }>('SELECT kind FROM post_group_overrides WHERE post_id = ?')
    .get(id)
  return row?.kind ?? null
}

/** 一对 post 的用户裁决，`edgeKey` 语义（方向无关）。 */
function verdictOf(a: number, b: number): 'same' | 'different' | null {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const edge = listEdgesFor(sqlite, lo).find(e => e.postA === lo && e.postB === hi)
  return edge?.userVerdict ?? null
}

beforeEach(() => {
  sqlite.exec('DELETE FROM post_variant_edges; DELETE FROM post_group_overrides; DELETE FROM posts')
  for (const id of [1, 2, 3, 4, 5]) insertPost(sqlite, { id })
})

describe('groupTogether', () => {
  it('把三张图合成一组：最小 id 当封面，其余指向它', () => {
    expect(groupTogether(sqlite, [3, 1, 2])).toBe(true)
    expect(canonicalOf(1)).toBeNull()
    expect(canonicalOf(2)).toBe(1)
    expect(canonicalOf(3)).toBe(1)
  })

  it('写星形的 same 边（封面与其余每一个），而不是全连接', () => {
    groupTogether(sqlite, [1, 2, 3])
    expect(verdictOf(1, 2)).toBe('same')
    expect(verdictOf(1, 3)).toBe('same')
    // 2–3 这一对用户从没看过，不该被写成"用户决定过"。
    expect(verdictOf(2, 3)).toBeNull()
    expect(listUserVerdicts(sqlite)).toHaveLength(2)
  })

  it('显式指定的 canonical 优先于最小 id', () => {
    expect(groupTogether(sqlite, [1, 2, 3], 3)).toBe(true)
    expect(canonicalOf(3)).toBeNull()
    expect(canonicalOf(1)).toBe(3)
    expect(canonicalOf(2)).toBe(3)
    expect(verdictOf(3, 1)).toBe('same')
  })

  it('沿用已有组的封面，而不是把封面顶掉', () => {
    groupTogether(sqlite, [2, 3]) // 2 成为封面
    expect(groupTogether(sqlite, [3, 4])).toBe(true)
    expect(canonicalOf(2)).toBeNull()
    expect(canonicalOf(4)).toBe(2)
    expect(verdictOf(2, 4)).toBe('same')
  })

  it('清掉参与者的 standalone override —— 否则重建会再把它拆出去', () => {
    clearCanonical(sqlite, [2])
    expect(overrideOf(2)).toBe('standalone')
    groupTogether(sqlite, [1, 2])
    expect(overrideOf(2)).toBeNull()
    expect(canonicalOf(2)).toBe(1)
  })

  it('不留两级指针链：被并进来的封面，它的成员一起跟过来', () => {
    groupTogether(sqlite, [3, 4]) // 3 是封面，4 指向 3
    expect(groupTogether(sqlite, [1, 3])).toBe(true)
    expect(canonicalOf(1)).toBeNull()
    expect(canonicalOf(3)).toBe(1)
    expect(canonicalOf(4)).toBe(1)
  })

  it('少于两个 id 返回 false 且什么都不写', () => {
    expect(groupTogether(sqlite, [1])).toBe(false)
    expect(groupTogether(sqlite, [])).toBe(false)
    expect(groupTogether(sqlite, [2, 2])).toBe(false) // 去重后只剩一个
    expect(listUserVerdicts(sqlite)).toHaveLength(0)
    expect(canonicalOf(1)).toBeNull()
  })

  it('有 id 不存在时返回 false 且什么都不写', () => {
    expect(groupTogether(sqlite, [1, 999])).toBe(false)
    expect(groupTogether(sqlite, [1, 2], 999)).toBe(false)
    expect(listUserVerdicts(sqlite)).toHaveLength(0)
    expect(canonicalOf(2)).toBeNull()
  })
})

describe('markDifferent', () => {
  it('立刻把成员从封面下拆开，并留下 different 边和 standalone', () => {
    groupTogether(sqlite, [1, 2, 3])
    expect(markDifferent(sqlite, 1, 2)).toBe(true)
    expect(canonicalOf(2)).toBeNull()
    expect(overrideOf(2)).toBe('standalone')
    expect(verdictOf(1, 2)).toBe('different')
    // 同组的另一个不受影响。
    expect(canonicalOf(3)).toBe(1)
  })

  it('参数顺序反过来也拆成员，不拆封面', () => {
    groupTogether(sqlite, [1, 2])
    expect(markDifferent(sqlite, 2, 1)).toBe(true)
    expect(canonicalOf(1)).toBeNull()
    expect(canonicalOf(2)).toBeNull()
    expect(overrideOf(2)).toBe('standalone')
    expect(overrideOf(1)).toBeNull()
  })

  it('两张都是成员时拆掉第二个参数（用户点的那一个）', () => {
    groupTogether(sqlite, [1, 2, 3])
    expect(markDifferent(sqlite, 2, 3)).toBe(true)
    expect(canonicalOf(2)).toBe(1)
    expect(canonicalOf(3)).toBeNull()
    expect(overrideOf(3)).toBe('standalone')
    expect(verdictOf(2, 3)).toBe('different')
  })

  it('本来就不同组时只写裁决，不动任何指针', () => {
    expect(markDifferent(sqlite, 1, 2)).toBe(true)
    expect(verdictOf(1, 2)).toBe('different')
    expect(canonicalOf(1)).toBeNull()
    expect(canonicalOf(2)).toBeNull()
    expect(overrideOf(2)).toBeNull()
  })

  it('覆盖之前的 same 裁决', () => {
    groupTogether(sqlite, [1, 2])
    expect(verdictOf(1, 2)).toBe('same')
    markDifferent(sqlite, 1, 2)
    expect(verdictOf(1, 2)).toBe('different')
    expect(listUserVerdicts(sqlite)).toHaveLength(1)
  })

  it('同一个 id 或不存在的 id 返回 false', () => {
    expect(markDifferent(sqlite, 1, 1)).toBe(false)
    expect(markDifferent(sqlite, 1, 999)).toBe(false)
    expect(listUserVerdicts(sqlite)).toHaveLength(0)
  })
})

describe('groupTogether 的封面意图', () => {
  it('显式指定的封面写进 override —— 否则下一次重建按最小 id 把它顶掉', () => {
    insertPost(sqlite, { id: 10 })
    insertPost(sqlite, { id: 11 })
    insertPost(sqlite, { id: 12 })

    groupTogether(sqlite, [10, 11, 12], 12)

    expect(listGroupOverrides(sqlite).canonical.has(12)).toBe(true)
    // 钉住的是"活过重建"，不是"写了一行"：重建按最小 id 选代表，10 才是最小的。
    const assignments = assignFromEdges(
      [{ a: 10, b: 11, strength: 1 }, { a: 11, b: 12, strength: 1 }],
      { pinned: listGroupOverrides(sqlite).canonical },
    )
    expect(assignments.every(([, canonical]) => canonical === 12)).toBe(true)
  })

  it('没指定封面就不 pin —— 用户说的是"这几张是一组"，不是"这张当代表"', () => {
    insertPost(sqlite, { id: 20 })
    insertPost(sqlite, { id: 21 })

    groupTogether(sqlite, [20, 21])

    expect(listGroupOverrides(sqlite).canonical.size).toBe(0)
  })
})

describe('手动评分镜像到整组', () => {
  beforeEach(() => {
    insertPost(sqlite, { id: 100 })
    for (const id of [101, 102]) {
      insertPost(sqlite, { id })
      sqlite.prepare('UPDATE posts SET canonical_post_id = 100 WHERE id = ?').run(id)
    }
  })

  const scoreOf = (id: number) =>
    sqlite.prepare<[number], { score: number }>('SELECT score FROM posts WHERE id = ?').get(id)!.score

  it('给代表打分，全组跟着变', () => {
    updateField(sqlite, 100, 'score', 4)

    expect([scoreOf(100), scoreOf(101), scoreOf(102)]).toEqual([4, 4, 4])
  })

  it('给成员打分，代表和其它成员一起变', () => {
    // 缺口就在这里：镜像原本是 `WHERE canonical_post_id = <被打分的 id>`，
    // 给成员打分时匹配 0 行，而列表里显示的是代表 —— 用户看到分"没生效"。
    updateField(sqlite, 101, 'score', 5)

    expect([scoreOf(100), scoreOf(101), scoreOf(102)]).toEqual([5, 5, 5])
  })

  it('不在组里的图只改自己', () => {
    insertPost(sqlite, { id: 200 })

    updateField(sqlite, 200, 'score', 3)

    expect([scoreOf(200), scoreOf(100)]).toEqual([3, 0])
  })

  it('批量打分同样解析到组代表', () => {
    insertPost(sqlite, { id: 300 })

    bulkUpdateField(sqlite, [101, 300], 'score', 2)

    expect([scoreOf(100), scoreOf(101), scoreOf(102), scoreOf(300)]).toEqual([2, 2, 2, 2])
  })

  it('0 分同样清空整组，而不是留下半组旧分', () => {
    updateField(sqlite, 100, 'score', 4)

    updateField(sqlite, 102, 'score', 0)

    expect([scoreOf(100), scoreOf(101), scoreOf(102)]).toEqual([0, 0, 0])
  })

  it('不存在的 id 不写任何分', () => {
    expect(updateField(sqlite, 999_999, 'score', 5)).toBe(false)
    expect(scoreOf(100)).toBe(0)
  })
})
