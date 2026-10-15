/**
 * 测试库脚手架。
 *
 * 库本身就是 `createTestDb()`（`../testing.ts`，跑完全部迁移的 `:memory:` 连接，与生产
 * 同一个 `createDb`）；这里只把它包成 `{ sqlite, cleanup }`，好放进 `afterAll`。
 *
 * 建在真实迁移上而不是手写 schema：`prod-schema.test.ts` 与 `schema.test.ts` 的
 * 存在前提就是「迁移才是唯一事实」，测试库理应走同一条路。
 */
import type Database from 'better-sqlite3'
import { Buffer } from 'node:buffer'
import { createTestDb } from '../testing.js'

export interface TempDb {
  sqlite: Database.Database
  /** 关库；放进 `afterAll`。 */
  cleanup: () => void
}

export function createTempDb(): TempDb {
  const sqlite = createTestDb()
  return { sqlite, cleanup: () => sqlite.close() }
}

/**
 * 一条 1152 维单位向量。
 *
 * `seed` 决定朝向；`tilt` 再叠一个不同频率的分量，用来在需要「像但不是副本」的场景里
 * 把余弦调到 MAX_PAIR_COSINE(0.94) 与 SIMILAR_MIN_DISTANCE(0.04) 之间。
 */
export function unitBlob(seed: number, tilt = 0): Buffer {
  const vec = new Float32Array(1152)
  for (let i = 0; i < vec.length; i++)
    vec[i] = Math.sin(seed * 7.13 + i * 0.011) + tilt * Math.cos(i * 0.037)
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
  return Buffer.from(vec.buffer)
}

/** 一张最小可用的 post。`score` 是人工星级（similar 采样按它分档）。 */
export function insertPost(
  sqlite: Database.Database,
  { id, score = 0 }: { id: number, score?: number },
): void {
  sqlite
    .prepare(
      "INSERT INTO posts (id, file_path, file_name, extension, width, height, score)"
      + " VALUES (?, 'dir', ?, 'jpg', 100, 100, ?)",
    )
    .run(id, `f${id}`, score)
}

/**
 * 给一张 post 挂一个标签。
 *
 * `post_has_tag.tag_name` 有 FK 到 `tags(name)`，而测试库开了 `foreign_keys = ON`，
 * 所以标签行要先存在 —— 这两步分开写过一次就会忘第二次，包在一起。
 */
export function tagPost(sqlite: Database.Database, id: number, tag: string): void {
  sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag)
  sqlite.prepare('INSERT OR IGNORE INTO post_has_tag (post_id, tag_name) VALUES (?, ?)').run(id, tag)
}

/** 给一张 post 挂上 SigLIP2 向量。vec0 是虚表，post_id 要走 BigInt。 */
export function insertVector(sqlite: Database.Database, id: number, blob = unitBlob(id)): void {
  sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), blob)
}
