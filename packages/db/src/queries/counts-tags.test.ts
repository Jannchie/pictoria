/**
 * 带过滤的 tag facet：`countAllTags`（分块 + 补集）+ `selectTagCounts`（内存里按名字筛）
 * 与改写前的单条 `posts JOIN post_has_tag ... LIKE ... GROUP BY ... LIMIT` 对拍。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SqliteHandle } from '../connection.js'
import { buildWhere, type PostFilter } from '../filters.js'
import { whereSql } from '../sql.js'
import { createTestDb } from '../testing.js'
import { countAllTags, countByTag, selectTagCounts } from './counts.js'

const N = 900
let sqlite: SqliteHandle

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// 名字里有大小写、LIKE 元字符、非 ASCII（UTF-8 字节序和 UTF-16 码元序不同的那种）。
const TAGS = ['1girl', 'Solo', 'long_hair', 'long%hair', 'BLUE_eyes', 'blue_eyes', '猫耳', 'ｈａｔ', '😀smile', '～wave', 'a', 'b', 'c', 'd']

beforeAll(() => {
  sqlite = createTestDb()
  const r = rng(7)
  const insPost = sqlite.prepare(`INSERT INTO posts (id, file_path, file_name, extension, rating, score) VALUES (?, ?, ?, 'png', ?, ?)`)
  const insAes = sqlite.prepare(`INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', ?)`)
  const insTag = sqlite.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`)
  const link = sqlite.prepare(`INSERT INTO post_has_tag (post_id, tag_name, is_auto) VALUES (?, ?, 0)`)
  sqlite.transaction(() => {
    for (const t of TAGS) insTag.run(t)
    for (let id = 1; id <= N; id++) {
      insPost.run(id * 3, `f${id % 4}`, `p${id}`, Math.floor(r() * 5), r() < 0.3 ? 3 : 0)
      if (r() < 0.8)
        insAes.run(id * 3, r())
      TAGS.forEach((t, i) => {
        // 头几个 tag 很热，后面的越来越冷，制造大量打平。
        if (r() < 0.9 / (1 + i * 0.4))
          link.run(id * 3, t)
      })
    }
  })()
  // 组成员：在建好 post_has_tag 之后再分组，走触发器维护 post_count。
  sqlite.prepare(`UPDATE posts SET canonical_post_id = id - 3 WHERE id % 21 = 0`).run()
})

afterAll(() => sqlite.close())

function legacy(f: PostFilter, { query = '', limit = 50, extraNames = [] as string[] } = {}) {
  const { where, params, joins } = buildWhere(f)
  const parts: string[] = []
  if (query) {
    parts.push(`pt.tag_name LIKE ? ESCAPE '\\'`)
    params.push(`%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
  }
  if (extraNames.length) {
    parts.push(`pt.tag_name IN (${extraNames.map(() => '?').join(',')})`)
    params.push(...extraNames)
  }
  if (parts.length)
    where.push(`(${parts.join(' OR ')})`)
  return sqlite
    .prepare<unknown[], { tag_name: string, count: number }>(
      `SELECT pt.tag_name AS tag_name, count(*) AS count FROM posts p JOIN post_has_tag pt ON pt.post_id = p.id `
      + `${joins.join('\n')} ${whereSql(where)} GROUP BY pt.tag_name ORDER BY count DESC, pt.tag_name ASC LIMIT ?`,
    )
    .all(...params, limit)
}

const FILTERS: PostFilter[] = [
  { rating: [1] }, // 小命中 → 直接数
  { rating: [0, 1, 2, 3] }, // 大命中 → 补集
  { score: [3] },
  { tags: ['a'] },
  { tags: ['1girl', 'Solo'] },
  { folder: 'f1' },
  { silvaScoreLevels: ['A', 'UNSCORED'] }, // 过滤子句里有 NULL（LEFT JOIN）—— 补集要 NOT COALESCE
  { silvaScoreLevels: ['E'] },
  { onlyCanonical: false },
  { onlyCanonical: false, rating: [0, 1, 2] },
  { rating: [9] }, // 空命中
]

describe('countByTag（过滤路径）与改写前的单条 SQL 一致', () => {
  it.each(FILTERS.map(f => [JSON.stringify(f), f] as const))('%s', (_label, f) => {
    for (const opts of [{}, { limit: 3 }, { query: 'LONG' }, { query: '%' }, { query: '_' }, { query: 'e', extraNames: ['猫耳'] }, { extraNames: ['ｈａｔ', 'nope'] }, { limit: 1000 }])
      expect(countByTag(sqlite, f, opts), JSON.stringify(opts)).toEqual(legacy(f, opts))
  })
})

describe('分块（每块 37 张）与不分块结果相同', () => {
  it.each(FILTERS.map(f => [JSON.stringify(f), f] as const))('%s', (_label, f) => {
    expect(countAllTags(sqlite, f, { chunkPosts: 37 })).toEqual(countAllTags(sqlite, f))
    expect(selectTagCounts(countAllTags(sqlite, f, { chunkPosts: 37 }), { limit: 1000 })).toEqual(legacy(f, { limit: 1000 }))
  })
})

describe('selectTagCounts', () => {
  it('LIKE 语义：只折叠 ASCII 大小写，% 和 _ 按字面', () => {
    const all: Array<[string, number]> = [['Long_Hair', 3], ['longXhair', 2], ['ＬＯＮＧ', 1]]
    expect(selectTagCounts(all, { query: 'long_' }).map(r => r.tag_name)).toEqual(['Long_Hair'])
    expect(selectTagCounts(all, { query: 'ｌｏｎｇ' })).toEqual([])
  })
})

describe('countAllTags', () => {
  it('shouldAbort 为真时以 AbortError 中止', () => {
    expect(() => countAllTags(sqlite, { rating: [1] }, { shouldAbort: () => true })).toThrow(expect.objectContaining({ name: 'AbortError' }))
  })
})
