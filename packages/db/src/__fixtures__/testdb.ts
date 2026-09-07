/**
 * 测试用的临时库脚手架。
 *
 * `mkdtemp → new Database → sqliteVec.load → foreign_keys=ON → runMigrations` 这五步
 * 在 packages/db 的测试里曾经被逐行抄了六份（dedup / backfill / listwise 三份，
 * 2026-08-20 的采样改动一次又加了三份）。它不是「每个测试各自独立」，而是同一段
 * 开场白 —— 迁移里一旦多出一张 vec0 虚表或一条 PRAGMA，六处都要改。
 *
 * 建在真实迁移上而不是手写 schema：`prod-schema.test.ts` 与 `schema.test.ts` 的
 * 存在前提就是「迁移才是唯一事实」，测试库理应走同一条路。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'

export interface TempDb {
  sqlite: Database.Database
  /** 关库并删掉临时目录；放进 `afterAll`。 */
  cleanup: () => void
}

export function createTempDb(label: string): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pictoria-${label}-`))
  const sqlite = new Database(path.join(dir, 'test.sqlite'))
  sqliteVec.load(sqlite) // 迁移里有 vec0 虚表
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite, MIGRATIONS_DIR)
  return {
    sqlite,
    cleanup: () => {
      sqlite.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
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
