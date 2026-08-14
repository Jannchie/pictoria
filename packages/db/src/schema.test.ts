/**
 * schema.ts 是手抄的，这个测试保证它没抄错。
 *
 * 做法：拿 `server/migrations/*.sql` —— 也就是 schema 的唯一真理 —— 在内存里建一个
 * 全新的库，再把手写的 drizzle 声明逐列对上去。对着迁移而不是对着某台机器的
 * pictoria.sqlite，是因为后者只能证明"在我这台机器上是对的"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from './migrate.js'
import { undeclaredTables, verifySchema } from './verify-schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))


let dbPath: string
let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-schema-'))
  dbPath = path.join(tmpDir, 'fresh.sqlite')

  const sqlite = new Database(dbPath)
  // 迁移里有 vec0 虚表，不加载扩展会直接建表失败。
  sqliteVec.load(sqlite)
  sqlite.pragma('foreign_keys = ON')
  const applied = runMigrations(sqlite, MIGRATIONS_DIR)
  expect(applied).toBeGreaterThan(0)
  sqlite.close()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('手写 schema 对齐 server/migrations', () => {
  it('每一列的存在性 / notNull / 主键都与迁移建出的库一致', () => {
    const mismatches = verifySchema(dbPath)
    // 失败时把差异原样打出来，比 "expected 3 to be 0" 有用得多
    expect(mismatches.map(m => `${m.table}.[${m.kind}] ${m.detail}`)).toEqual([])
  })

  it('没有漏声明的表', () => {
    expect(undeclaredTables(dbPath)).toEqual([])
  })

  it('迁移可重复执行（第二次应用 0 条）', () => {
    const sqlite = new Database(dbPath)
    sqliteVec.load(sqlite)
    expect(runMigrations(sqlite, MIGRATIONS_DIR)).toBe(0)
    sqlite.close()
  })
})

describe('vec0 与生成列在迁移建出的库上确实可用', () => {
  it('生成列 full_path / aspect_ratio 由 SQLite 自己算出来', () => {
    const sqlite = new Database(dbPath)
    sqliteVec.load(sqlite)
    sqlite
      .prepare(
        `insert into posts (file_path, file_name, extension, width, height)
         values ('a/b', 'c', 'jpg', 800, 400)`,
      )
      .run()
    const row = sqlite
      .prepare<[], { full_path: string, aspect_ratio: number }>(
        'select full_path, aspect_ratio from posts limit 1',
      )
      .get()!
    expect(row.full_path).toBe('a/b/c.jpg')
    expect(row.aspect_ratio).toBeCloseTo(2)
    sqlite.close()
  })

  it('vec0 表能写能 KNN（rowid 必须是 BigInt）', () => {
    const sqlite = new Database(dbPath)
    sqliteVec.load(sqlite)

    const vec = (seed: number) =>
      Buffer.from(new Float32Array(Array.from({ length: 1152 }, (_, i) => (i + seed) % 7)).buffer)

    const ins = sqlite.prepare(
      'insert into post_vectors_siglip2 (post_id, embedding) values (?, ?)',
    )
    ins.run(1n, vec(0))
    ins.run(2n, vec(3))

    const hits = sqlite
      .prepare<[Buffer, number], { post_id: number, distance: number }>(
        `select post_id, distance from post_vectors_siglip2
         where embedding match ? and k = ? order by distance`,
      )
      .all(vec(0), 2)

    expect(hits).toHaveLength(2)
    expect(hits[0]!.post_id).toBe(1)
    expect(hits[0]!.distance).toBeCloseTo(0)
    sqlite.close()
  })

  it('JS number 当 vec0 主键会被拒 —— 这条钉住那个坑', () => {
    const sqlite = new Database(dbPath)
    sqliteVec.load(sqlite)
    const buf = Buffer.from(new Float32Array(1152).buffer)
    expect(() =>
      sqlite
        .prepare('insert into post_vectors_siglip2 (post_id, embedding) values (?, ?)')
        .run(99, buf),
    ).toThrow(/integer/i)
    sqlite.close()
  })

  it('ON DELETE CASCADE 真的级联（foreign_keys = ON 生效）', () => {
    const sqlite = new Database(dbPath)
    sqliteVec.load(sqlite)
    sqlite.pragma('foreign_keys = ON')

    const { lastInsertRowid } = sqlite
      .prepare(`insert into posts (file_path, file_name, extension) values ('x', 'y', 'jpg')`)
      .run()
    const postId = Number(lastInsertRowid)
    sqlite.prepare(`insert into tags (name) values ('cascade-probe')`).run()
    sqlite
      .prepare('insert into post_has_tag (post_id, tag_name) values (?, ?)')
      .run(postId, 'cascade-probe')

    sqlite.prepare('delete from posts where id = ?').run(postId)
    const left = sqlite
      .prepare<[number], { n: number }>('select count(*) n from post_has_tag where post_id = ?')
      .get(postId)!
    expect(left.n).toBe(0)
    sqlite.close()
  })
})
