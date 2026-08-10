/**
 * `post_waifu_scores` / `post_aesthetic_scores` 的读取 —— 对应 Python 侧
 * `db/repositories/scores.py`。
 */
import type BetterSqlite3 from 'better-sqlite3'

export interface WaifuBucketCount {
  bucket: number
  count: number
}

/**
 * waifu 分数直方图：`[(bucket, count), ...]`，bucket 固定 0..9 全在（零填充）。
 *
 * 分档是分数向下取整并**夹到 9**，好让右闭端点 `score == 10.0` 落进 bucket 9
 * 而不是溢出成 bucket 10：`[0,1), [1,2), …, [8,9), [9,10]`。零填充是给图表层的 ——
 * 十根柱子都得在，不该让渲染侧自己补洞。
 */
export function waifuScoreDistribution(sqlite: BetterSqlite3.Database): WaifuBucketCount[] {
  const rows = sqlite
    .prepare<[], { bucket: number, count: number }>(
      `SELECT
         CASE WHEN score >= 9 THEN 9 ELSE CAST(score AS INTEGER) END AS bucket,
         count(*) AS count
       FROM post_waifu_scores
       GROUP BY bucket`,
    )
    .all()

  const counts = new Map<number, number>()
  for (let b = 0; b < 10; b++) counts.set(b, 0)
  for (const r of rows) counts.set(Number(r.bucket), Number(r.count))

  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count }))
}
