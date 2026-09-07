/**
 * `post_waifu_scores` / `post_aesthetic_scores` 的读取 —— 形状承自已退役的 Python 侧
 * `db/repositories/scores.py`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE } from '../scorers.js'
import { placeholders } from '../sql.js'

export interface WaifuBucketCount {
  bucket: number
  count: number
}

/**
 * 一批 post 在某个 scorer 下的分数。**缺分的 id 不出现在结果里** —— 「没有分」是跳过
 * 还是补默认值由调用方决定，这里不替它选：补个 0 会让一张没打过分的图看起来是最差的。
 *
 * 一次 IN 查询而不是逐个探：listwise 一次采样是 3~5 组、每组 4~8 张，逐个探就是二三十
 * 次 prepare/step（同 withEmbedding 那条注释里量到的成本）。
 */
export function scorerValuesFor(
  sqlite: BetterSqlite3.Database,
  postIds: number[],
  scorer: string,
): Map<number, number> {
  if (postIds.length === 0)
    return new Map()
  const rows = sqlite
    .prepare<unknown[], { post_id: number, score: number }>(
      `SELECT post_id, score FROM ${AESTHETIC_SCORES_TABLE}`
      + ` WHERE scorer = ? AND post_id IN (${placeholders(postIds.length)})`,
    )
    .all(scorer, ...postIds)
  return new Map(rows.map(r => [Number(r.post_id), Number(r.score)]))
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
