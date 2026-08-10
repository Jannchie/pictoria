/**
 * 近重复分组的数据侧 —— 对应 Python 的 `services/dedup.py` 里除矩阵乘之外的一切。
 *
 * 检测完全由 SigLIP 2 驱动：余弦距离在 `threshold` 以内的两个 post 被当成同一张图
 * （覆盖不同分辨率 / 编码，以及近似差分）。分组是**非破坏性**的：成员的行原封不动，
 * 只是多一个 `canonical_post_id` 指针（所以 Danbooru 去重不会重新下载）。一个簇里
 * id 最小的那个是 canonical，其余都指向它；组只有一层，永远不成链。
 *
 * 两条代码路径的分工和 Python 侧一致：
 *
 * * **全量重建**（`exportVectorMatrix` → worker 矩阵乘 → `assignFromPairs` →
 *   `replaceAllGroups`）：逐个 vec0 KNN 在 17 万行的表上约 1 秒一条，17 万条不可行
 *   （实测约 48 小时），所以只能一次性把全部向量喂给一次分块 `X @ X.T`。
 * * **增量**（`assignGroupForPost`）：一次 KNN 约 1 秒，对一次 sync 新增的那几张图
 *   完全够用，而且直接复用 vec0 索引。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { closeSync, openSync, writeSync } from 'node:fs'
import { knn, SIGLIP2_TABLE } from './vectors.js'

/**
 * 导出全库向量到一个裸 float32 文件，返回与文件行序平行的 post id。
 *
 * 为什么要落地成文件而不是随 payload 走：22.3 万条 × 1152 维 = 1.0 GB，base64
 * 之后 1.3 GB，一行 JSON 装不下。文件不是数据库，所以 §D1（worker 只算不碰库）
 * 依然成立 —— worker 拿到的仍然只是它算不出来的那部分输入。
 *
 * **id 升序**是有意义的，不只是为了确定性：贪心分配按行下标从小到大跑，行序即 id
 * 序才能保证"簇里最早的那个 post 拿到 canonical 位"。
 *
 * 逐行写而不是先在内存里拼一个大 Buffer —— 1 GB 的 Buffer 会顶到 Node 的堆上限，
 * 而 better-sqlite3 的 iterate 本来就是流式的。
 */
export function exportVectorMatrix(
  sqlite: BetterSqlite3.Database,
  filePath: string,
): { ids: number[], count: number, dim: number } {
  const ids: number[] = []
  let dim = 0
  const fd = openSync(filePath, 'w')
  try {
    const rows = sqlite
      .prepare<[], { post_id: number, embedding: Buffer }>(
        `SELECT post_id, embedding FROM ${SIGLIP2_TABLE} ORDER BY post_id ASC`,
      )
      .iterate()
    for (const row of rows) {
      const blob = row.embedding
      const width = blob.length / 4
      // 宽度不一致的行会让 worker 那边的 reshape 静默错位 —— 与其算出一堆噪声，
      // 不如在这里就停下（同 `codec.py` 里检查宽度而不是推断宽度的理由）。
      if (dim === 0)
        dim = width
      else if (width !== dim)
        throw new Error(`post ${row.post_id} 的向量是 ${width} 维，与前面的 ${dim} 维不一致`)
      writeSync(fd, blob)
      ids.push(Number(row.post_id))
    }
  }
  finally {
    closeSync(fd)
  }
  return { ids, count: ids.length, dim }
}

/**
 * 上三角邻接 → `(member_id, canonical_id)` 的完整分配。
 *
 * 贪心，行下标升序：第一个还没被认领的下标就是一个 canonical 种子，它阈值内、
 * 下标更大、且还没被认领的邻居加入它的组。已被认领的下标永远不会再成为种子，
 * 所以不会形成链，而下标即 id 序意味着最早的 post 总是赢得 canonical 位。
 *
 * 纯函数：不碰库，于是这段逻辑的正确性可以脱离 GPU 单独钉住。
 */
export function assignFromPairs(
  ids: number[],
  pairs: Array<[number, number]>,
): Array<[number, number]> {
  const adjacency = new Map<number, number[]>()
  for (const [i, j] of pairs) {
    // worker 承诺回传的是上三角，但它跨了一个进程边界，所以这里按输入对待：
    // 顺手规整成 i < j，而不是相信承诺。
    const [lo, hi] = i < j ? [i, j] : [j, i]
    if (lo === hi)
      continue
    const bucket = adjacency.get(lo)
    if (bucket)
      bucket.push(hi)
    else adjacency.set(lo, [hi])
  }

  const claimed = new Map<number, number>() // member_idx -> canonical_idx
  for (let idx = 0; idx < ids.length; idx++) {
    if (claimed.has(idx))
      continue
    for (const j of adjacency.get(idx) ?? []) {
      if (claimed.has(j))
        continue
      claimed.set(j, idx)
    }
  }

  const out: Array<[number, number]> = []
  for (const [member, canonical] of claimed)
    out.push([ids[member]!, ids[canonical]!])
  return out
}

/**
 * 一次事务内换掉全部分组指针。
 *
 * `assignments` 是完整的新分组；没列进来的 post 就是（或恢复成）canonical。
 * 清空 + 重设必须在**同一个事务**里：分开做的话，从清空到写完之间（一次 GPU
 * 计算加上两万多条 UPDATE，分钟级）每个成员都会在列表里冒出来。
 *
 * UPDATE 照常触发 canonical 分组触发器，`tags.post_count` 仍然只数可见的
 * canonical post。
 */
export function replaceAllGroups(
  sqlite: BetterSqlite3.Database,
  assignments: Array<[number, number]>,
): void {
  const clear = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = NULL WHERE canonical_post_id IS NOT NULL',
  )
  const set = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  sqlite.transaction(() => {
    clear.run()
    for (const [member, canonical] of assignments) set.run(canonical, member)
  })()
}

/** 把 `memberIds` 指向 `canonicalId`。调用方保证 canonical 自身是 canonical 且不在成员里。 */
export function setCanonical(
  sqlite: BetterSqlite3.Database,
  memberIds: number[],
  canonicalId: number,
): void {
  if (!memberIds.length)
    return
  const ph = memberIds.map(() => '?').join(',')
  sqlite
    .prepare(
      `UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`,
    )
    .run(canonicalId, ...memberIds)
}

/** 增量路径拉多少个邻居。近重复簇都很小，200 绰绰有余；只用阈值内的那个前缀。 */
export const DEDUP_KNN_K = 200

/**
 * 把一张刚算完向量的 `postId` 挂到已有的组上，挂不上就返回 `null`。
 *
 * 全量重建才是权威的确定性结果，这个只是尽力而为的增量对应物：把 `postId` 指向
 * 它最近的、阈值内邻居所属的 canonical。假设 `postId` 当前未分组且名下没有成员
 * （对一张刚导入的图成立）。
 */
export function assignGroupForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
  { threshold, knnK = DEDUP_KNN_K }: { threshold: number, knnK?: number },
): number | null {
  const neighbours = sqlite
    .prepare<[number], { id: number, canonical_post_id: number | null }>(
      'SELECT id, canonical_post_id FROM posts WHERE id = ?',
    )
  for (const [neighbourId, distance] of knn(sqlite, postId, knnK + 1)) {
    if (neighbourId === postId)
      continue
    if (distance > threshold)
      break // knn 按距离升序，第一个超阈值之后不会再有更近的
    const row = neighbours.get(neighbourId)
    if (!row)
      continue
    const canonicalId = row.canonical_post_id ?? row.id
    if (canonicalId === postId)
      continue // 永远不让一个 post 指向自己
    setCanonical(sqlite, [postId], canonicalId)
    return canonicalId
  }
  return null
}
