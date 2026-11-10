/**
 * 0022 的 ANALYZE 与它依赖的 stat4。
 *
 * 真库上 `WHERE canonical_post_id IS NULL ORDER BY created_at DESC LIMIT 100` 没有统计时
 * 走 ix_posts_canonical + TEMP B-TREE（409–1700 ms），有统计时沿 ix_posts_created_at 扫
 * （< 1 ms）。这里用一个同分布（80% canonical）的内存库把这个翻转钉住，也钉住那个坑：
 * 带 analysis_limit 的 ANALYZE 会删掉 stat4，计划随之翻回去 —— 所以维护时不能设 limit。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTempDb } from './__fixtures__/testdb.js'

let sqlite: Database.Database
let cleanup: () => void

const HOME = 'SELECT p.id FROM posts p WHERE p.canonical_post_id IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT 100'
const plan = (): string =>
  (sqlite.prepare(`EXPLAIN QUERY PLAN ${HOME}`).all() as Array<{ detail: string }>).map(r => r.detail).join(' | ')

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb())
  const ins = sqlite.prepare('INSERT INTO posts(file_path, file_name, extension, created_at) VALUES (?, ?, ?, ?)')
  sqlite.transaction(() => {
    for (let i = 0; i < 20_000; i++) ins.run(`d${i % 50}`, `f${i}`, 'jpg', new Date(1.7e12 + i * 1000).toISOString())
  })()
  sqlite.exec('UPDATE posts SET canonical_post_id = id - 1 WHERE id % 5 = 0')
})

afterAll(() => cleanup())

it('迁移跑过 ANALYZE（统计表存在）', () => {
  expect(sqlite.prepare(`SELECT count(*) FROM sqlite_master WHERE name IN ('sqlite_stat1', 'sqlite_stat4')`).pluck().get()).toBe(2)
})

it('全量 ANALYZE 后首页沿 created_at 索引扫；带 limit 的 ANALYZE 清掉 stat4、计划翻回去', () => {
  // 迁移时的 ANALYZE 面对的是空表，等同于没有统计
  expect(plan()).toContain('TEMP B-TREE')

  sqlite.pragma('analysis_limit = 0')
  sqlite.exec('ANALYZE')
  expect(plan()).toBe('SCAN p USING INDEX ix_posts_created_at')
  expect(sqlite.prepare(`SELECT count(*) FROM sqlite_stat4 WHERE tbl = 'posts'`).pluck().get()).toBeGreaterThan(0)

  sqlite.pragma('analysis_limit = 200')
  sqlite.exec('ANALYZE posts')
  expect(sqlite.prepare(`SELECT count(*) FROM sqlite_stat4 WHERE tbl = 'posts'`).pluck().get()).toBe(0)
  expect(plan()).toContain('TEMP B-TREE')

  sqlite.pragma('analysis_limit = 0')
  sqlite.exec('ANALYZE posts')
  expect(plan()).toBe('SCAN p USING INDEX ix_posts_created_at')
})
