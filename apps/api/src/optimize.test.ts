/**
 * `optimizeDb`：表从空长大之后会被重新分析，而且分析是全量的（写 stat4）——
 * 哪怕这条连接上之前有人设过 `analysis_limit`。
 */
import { createTestDb } from '@pictoria/db'
import { expect, it } from 'vitest'
import { optimizeDb } from './optimize.js'

it('库从空表长大后 optimize 补上统计，首页计划翻对', () => {
  const sqlite = createTestDb()
  const ins = sqlite.prepare('INSERT INTO posts(file_path, file_name, extension, created_at) VALUES (?, ?, ?, ?)')
  sqlite.transaction(() => {
    for (let i = 0; i < 20_000; i++) ins.run(`d${i % 50}`, `f${i}`, 'jpg', new Date(1.7e12 + i * 1000).toISOString())
  })()
  sqlite.exec('UPDATE posts SET canonical_post_id = id - 1 WHERE id % 5 = 0')
  const plan = () => (sqlite.prepare(
    'EXPLAIN QUERY PLAN SELECT p.id FROM posts p WHERE p.canonical_post_id IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT 100',
  ).all() as Array<{ detail: string }>).map(r => r.detail).join(' | ')

  expect(plan()).toContain('TEMP B-TREE')
  sqlite.pragma('analysis_limit = 100') // 别处漏进来的 limit 不该让 stat4 缺席
  optimizeDb(sqlite)
  expect(sqlite.prepare(`SELECT count(*) FROM sqlite_stat4 WHERE tbl = 'posts'`).pluck().get()).toBeGreaterThan(0)
  expect(plan()).toBe('SCAN p USING INDEX ix_posts_created_at')
  sqlite.close()
})
