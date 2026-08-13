/**
 * SigLIP2 向量表的读取 —— 对应 Python 侧 `db/repositories/vectors.py` 里
 * 采样器真正用到的那几个同步核心（`exists_sync` / `existing_sync` /
 * `unit_vectors_sync` / `knn_sync`）。
 *
 * 表是 vec0 虚表，点查是虚表探测而不是 B-tree 探测（实测约 1.5 ms/条），
 * 所以这里凡是能批量的一律批量。
 */
import { placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'

export const SIGLIP2_TABLE = 'post_vectors_siglip2'

/**
 * 一个 `IN (...)` 里塞多少个 id。
 *
 * 现代 SQLite 的 SQLITE_MAX_VARIABLE_NUMBER 是 32766，老版本是 999 —— 900
 * 两边都不越界,而分块数本身不影响什么。与 Python 侧同值。
 */
const IN_CHUNK = 900

/** 这些 id 里哪些有 embedding —— 每块一条 `IN (...)`。 */
export function existingVectors(
  sqlite: BetterSqlite3.Database,
  postIds: number[],
): Set<number> {
  const found = new Set<number>()
  for (let start = 0; start < postIds.length; start += IN_CHUNK) {
    const chunk = postIds.slice(start, start + IN_CHUNK)
    const ph = placeholders(chunk.length)
    for (const row of sqlite
      .prepare<unknown[], { post_id: number }>(
        `SELECT post_id FROM ${SIGLIP2_TABLE} WHERE post_id IN (${ph})`,
      )
      .all(...chunk))
      found.add(row.post_id)
  }
  return found
}

/**
 * L2 归一化后的 embedding，于是点积**就是**余弦。
 *
 * 给那些要把候选彼此比较的调用方用 —— vec0 的 KNN 只回答"离种子多远"，
 * 而两个邻居彼此有多远它一个字都没说。
 */
export function unitVectors(
  sqlite: BetterSqlite3.Database,
  postIds: number[],
): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>()
  if (!postIds.length)
    return out
  const ph = placeholders(postIds.length)
  for (const row of sqlite
    .prepare<unknown[], { post_id: number, embedding: Buffer }>(
      `SELECT post_id, embedding FROM ${SIGLIP2_TABLE} WHERE post_id IN (${ph})`,
    )
    .all(...postIds)) {
    const raw = row.embedding
    const vec = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
    let sum = 0
    for (const v of vec) sum += v * v
    const norm = Math.sqrt(sum)
    if (!norm)
      continue
    const unit = new Float32Array(vec.length)
    for (let i = 0; i < vec.length; i++) unit[i] = vec[i]! / norm
    out.set(row.post_id, unit)
  }
  return out
}

/** 两个单位向量的余弦（= 点积）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

export function vectorExists(sqlite: BetterSqlite3.Database, postId: number): boolean {
  return sqlite
    .prepare(`SELECT 1 FROM ${SIGLIP2_TABLE} WHERE post_id = ?`)
    .get(postId) !== undefined
}

/**
 * 种子周围的原始 KNN 行 `(postId, distance)`，最近在前。种子自己也会回来
 * （distance ≈ 0），不想要的调用方自己滤。
 *
 * 种子没有 embedding 时返回 `[]` —— vec0 的 MATCH 拿到 NULL 查询向量会直接
 * 抛错，短路掉比让内层子查询冒出一个莫名其妙的 schema 级错误好。
 */
export function knn(
  sqlite: BetterSqlite3.Database,
  seedPostId: number,
  k: number,
): Array<[number, number]> {
  if (!vectorExists(sqlite, seedPostId))
    return []
  return sqlite
    .prepare<[number, number], { post_id: number, distance: number }>(
      `SELECT post_id, distance FROM ${SIGLIP2_TABLE} `
      + `WHERE embedding MATCH (SELECT embedding FROM ${SIGLIP2_TABLE} WHERE post_id = ?) `
      + `AND k = ? ORDER BY distance`,
    )
    .all(seedPostId, k)
    .map(r => [Number(r.post_id), Number(r.distance)] as [number, number])
}
