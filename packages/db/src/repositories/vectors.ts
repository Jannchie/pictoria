/**
 * SigLIP2 向量表的读取 —— 形状承自已退役的 Python 侧 `db/repositories/vectors.py` 里
 * 采样器真正用到的那几个同步核心（`exists_sync` / `existing_sync` /
 * `unit_vectors_sync` / `knn_sync`）。
 *
 * ⚠️ 对这张 vec0 虚表**不要**写 `post_id IN (...)`：vec0 只把 `post_id = ?` 认成点查，
 * `IN` 列表退化成全表扫描（真库 37 万行，64 个 id 110–170 ms；prepare 一次后逐条
 * `post_id = ?` 约 1 ms）。所以这里一律逐 id 点查，不批量。只问"有没有"的查影子表
 * `<table>_rowids`：普通 B-tree，`rowid` 就是 `post_id`，vec0 删行时连它那一行一起删。
 */
import type BetterSqlite3 from 'better-sqlite3'

export const SIGLIP2_TABLE = 'post_vectors_siglip2'

/** vec0 的影子 rowid 表（`rowid` = `post_id`）。存在性检查走它的主键。 */
export const SIGLIP2_ROWIDS_TABLE = `${SIGLIP2_TABLE}_rowids`

/** 这些 id 里哪些有 embedding —— 影子表上逐条主键点查。 */
export function existingVectors(
  sqlite: BetterSqlite3.Database,
  postIds: number[],
): Set<number> {
  const found = new Set<number>()
  if (!postIds.length)
    return found
  const probe = sqlite.prepare<[number], number>(`SELECT 1 FROM ${SIGLIP2_ROWIDS_TABLE} WHERE rowid = ?`).pluck()
  for (const id of postIds) {
    if (probe.get(id) !== undefined)
      found.add(id)
  }
  return found
}

/**
 * `post_id -> embedding blob`，原样取出不做数值转换；没有向量的 id 不出现。
 * 逐 id `post_id = ?` 点查（见文件头：vec0 上的 `IN` 是全表扫）。
 *
 * 交给 cairnq payload 的就是这段字节的 base64（见 `@pictoria/contracts` 的
 * codec）—— 从库里读出来到 worker 手上，中间没有任何一步把它变成十进制。
 */
export function embeddingBlobs(
  sqlite: BetterSqlite3.Database,
  postIds: number[],
): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  if (!postIds.length)
    return out
  const point = sqlite
    .prepare<[number], Buffer>(`SELECT embedding FROM ${SIGLIP2_TABLE} WHERE post_id = ?`)
    .pluck()
  for (const id of postIds) {
    if (out.has(id))
      continue
    const blob = point.get(id)
    if (blob !== undefined)
      out.set(id, blob)
  }
  return out
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
  for (const [postId, raw] of embeddingBlobs(sqlite, postIds)) {
    const vec = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
    let sum = 0
    for (const v of vec) sum += v * v
    const norm = Math.sqrt(sum)
    if (!norm)
      continue
    const unit = new Float32Array(vec.length)
    for (let i = 0; i < vec.length; i++) unit[i] = vec[i]! / norm
    out.set(postId, unit)
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
  return existingVectors(sqlite, [postId]).has(postId)
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
