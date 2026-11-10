/**
 * `tags.post_count`（只数 canonical post，触发器维护）在每条改分组 / 删 post 的写路径
 * 之后都要等于实数，以及对账函数能把漂移修回来。
 *
 * "实数"按定义直接数：`post_has_tag` JOIN 可见的 posts。
 */
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost, tagPost } from '../__fixtures__/testdb.js'
import { replaceAllGroups } from './dedup.js'
import { clearCanonical, deleteManyReturningPaths, groupTogether, makeCanonical } from './posts.js'
import { recountTagPostCounts, tagPostCountDrift } from './tag-counts.js'
import { deleteTag } from './tags.js'

let sqlite: Database.Database
let cleanup: () => void

beforeEach(() => {
  ({ sqlite, cleanup } = createTempDb())
  for (let id = 1; id <= 6; id++) {
    insertPost(sqlite, { id })
    tagPost(sqlite, id, 't')
    if (id % 2)
      tagPost(sqlite, id, 'odd')
  }
  // 1 是代表，2、3 是它的隐藏成员：t 可见 4 张（1、4、5、6），odd 可见 2 张（1、5）。
  replaceAllGroups(sqlite, [[2, 1], [3, 1]])
})
afterEach(() => cleanup())

const stored = (tag = 't') => sqlite.prepare('SELECT post_count FROM tags WHERE name = ?').pluck().get(tag)

describe('tags.post_count 跟着写路径走', () => {
  it('分组之后只数可见的', () => {
    expect([stored('t'), stored('odd')]).toEqual([4, 2])
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })

  it('删代表：成员经外键 SET NULL 变回可见，ungrouped 触发器把它们加回来', () => {
    deleteManyReturningPaths(sqlite, [1])
    expect(stored()).toBe(5)
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })

  it('删隐藏成员不动计数，代表和成员一起删也对', () => {
    deleteManyReturningPaths(sqlite, [2])
    expect(stored()).toBe(4)
    deleteManyReturningPaths(sqlite, [1, 3])
    expect(stored()).toBe(3)
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })

  it('设封面 / 拆组 / 手动合组 / 删 tag 之后都没有漂移', () => {
    makeCanonical(sqlite, 3)
    expect(tagPostCountDrift(sqlite)).toEqual([])
    clearCanonical(sqlite, [2])
    expect(tagPostCountDrift(sqlite)).toEqual([])
    groupTogether(sqlite, [4, 5, 3])
    expect(tagPostCountDrift(sqlite)).toEqual([])
    deleteTag(sqlite, 'odd')
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })

  // 漂移的来历：只删 posts 行、让外键级联去删 post_has_tag 时，计数触发器的 WHEN 已经
  // 读不到这张图（行没了 → NULL → 被当成 canonical），于是隐藏成员也被减了一次。
  // 迁移 0024 给 posts 加了 BEFORE DELETE 先删关联行，直接删也不再少算。
  it('直接 DELETE FROM posts 删成员也不会少算（0024 的 BEFORE DELETE 触发器）', () => {
    sqlite.prepare('DELETE FROM posts WHERE id = 2').run()
    expect(stored()).toBe(4)
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })

  it('直接 DELETE FROM posts 删 canonical 图照常减计数', () => {
    sqlite.prepare('DELETE FROM posts WHERE id = 1').run()
    expect(tagPostCountDrift(sqlite)).toEqual([])
  })
})

describe('recountTagPostCounts', () => {
  it('只改对不上的行，返回改了什么；第二次是空操作', () => {
    sqlite.prepare(`UPDATE tags SET post_count = post_count - 2 WHERE name = 't'`).run()
    sqlite.prepare(`INSERT INTO tags (name, post_count) VALUES ('ghost', 7)`).run()

    expect(recountTagPostCounts(sqlite)).toEqual([
      { name: 'ghost', stored: 7, actual: 0 },
      { name: 't', stored: 2, actual: 4 },
    ])
    expect([stored('t'), stored('odd'), stored('ghost')]).toEqual([4, 2, 0])
    expect(recountTagPostCounts(sqlite)).toEqual([])
  })
})
