/**
 * `drivingTag`：只换计划、不换结果。
 *
 * 冻结的 golden（`filters.test.ts`）钉的是不传提示时的 SQL 文本 —— 这里钉的是传了以后
 * 那一条 tag 子句怎么变、其余怎么不变，以及两种写法查出来的东西完全一样。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, insertPost, tagPost } from '../__fixtures__/testdb.js'
import { buildWhere } from '../filters.js'
import { whereSql } from '../sql.js'
import { aggregateStats, countByColumn, countByTag, countPosts } from './counts.js'
import { COUNT_DRIVE_MAX_POSTS, LIST_DRIVE_MAX_POSTS, pickDrivingTag } from './tag-drive.js'

const EXISTS = 'EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.tag_name = ?)'
const IN = 'p.id IN (SELECT pht.post_id FROM post_has_tag pht WHERE pht.tag_name = ?)'

describe('buildWhere 的 drivingTag', () => {
  it('不传就和冻结的 golden 一样全是 EXISTS', () => {
    expect(buildWhere({ tags: ['a', 'b'] }).where).toEqual(['p.canonical_post_id IS NULL', EXISTS, EXISTS])
  })

  it('只改写命中的那一个，参数顺序不变', () => {
    const w = buildWhere({ tags: ['a', 'b', 'c'], rating: [1] }, { drivingTag: 'b' })
    expect(w.where).toEqual(['p.canonical_post_id IS NULL', 'p.rating IN (?)', EXISTS, IN, EXISTS])
    expect(w.params).toEqual([1, 'a', 'b', 'c'])
  })

  it('重复的 tag 只改写第一次出现；不在 tags 里的提示被忽略', () => {
    expect(buildWhere({ tags: ['a', 'a'] }, { drivingTag: 'a' }).where.slice(1)).toEqual([IN, EXISTS])
    expect(buildWhere({ tags: ['a'] }, { drivingTag: 'zzz' }).where.slice(1)).toEqual([EXISTS])
    expect(buildWhere({ tags: ['a'] }, { drivingTag: null }).where.slice(1)).toEqual([EXISTS])
  })
})

let sqlite: Database.Database
let cleanup: () => void

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb())
  for (let id = 1; id <= 40; id++) {
    insertPost(sqlite, { id, score: id % 6 })
    tagPost(sqlite, id, 'common')
    if (id % 3 === 0)
      tagPost(sqlite, id, 'third')
    if (id % 10 === 0)
      tagPost(sqlite, id, 'rare')
  }
  // 组成员：canonical 过滤要照样生效
  sqlite.exec('UPDATE posts SET canonical_post_id = 1 WHERE id IN (30, 33)')
})

afterAll(() => cleanup())

describe('pickDrivingTag', () => {
  it('挑 post_count 最小的，超过阈值就不挑', () => {
    expect(pickDrivingTag(sqlite, ['common', 'third', 'rare'], 1000)).toBe('rare')
    expect(pickDrivingTag(sqlite, ['common', 'third'], 1000)).toBe('third')
    expect(pickDrivingTag(sqlite, ['common'], 10)).toBeNull()
    expect(pickDrivingTag(sqlite, [], 1000)).toBeNull()
    expect(pickDrivingTag(sqlite, null, 1000)).toBeNull()
  })

  it('库里没有的 tag 按 0 算（它驱动时立刻结束）', () => {
    expect(pickDrivingTag(sqlite, ['common', 'nope'], 0)).toBe('nope')
  })

  it('阈值：计数比列表宽', () => {
    expect(COUNT_DRIVE_MAX_POSTS).toBeGreaterThan(LIST_DRIVE_MAX_POSTS)
  })
})

describe('两种写法结果一致', () => {
  const ids = (tags: string[], drivingTag: string | null, onlyCanonical = true) => {
    const { where, params } = buildWhere({ tags, onlyCanonical }, { drivingTag })
    return sqlite.prepare(`SELECT p.id FROM posts p ${whereSql(where)} ORDER BY p.id`).pluck().all(...params)
  }

  it.each([
    [['rare']],
    [['third', 'rare']],
    [['common', 'third']],
    [['nope']],
  ])('%j', (tags) => {
    for (const onlyCanonical of [true, false]) {
      const base = ids(tags, null, onlyCanonical)
      for (const t of tags)
        expect(ids(tags, t, onlyCanonical)).toEqual(base)
    }
  })

  it('计数函数（内部选驱动 tag）的结果', () => {
    // rare: 10/20/30/40，其中 30 是组成员
    expect(countPosts(sqlite, { tags: ['rare'] })).toBe(3)
    expect(countPosts(sqlite, { tags: ['rare'], onlyCanonical: false })).toBe(4)
    // third ∩ rare = {30}，是成员
    expect(countPosts(sqlite, { tags: ['third', 'rare'] })).toBe(0)
    expect(countPosts(sqlite, { tags: ['common', 'third'] })).toBe(11) // 3..39 共 13 张，减去成员 30、33
    expect(countByTag(sqlite, { tags: ['rare'] })).toEqual([
      { tag_name: 'common', count: 3 },
      { tag_name: 'rare', count: 3 },
    ])
    // score = id % 6：10→4, 20→2, 40→4
    expect(countByColumn(sqlite, 'score', { tags: ['rare'] })).toEqual([{ score: 2, count: 1 }, { score: 4, count: 2 }])
    expect(aggregateStats(sqlite, { tags: ['rare'] }).total).toBe(3)
  })
})
