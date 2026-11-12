/**
 * `post_aesthetic_scores` 的读取 —— 形状承自已退役的 Python 侧
 * `db/repositories/scores.py`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { AestheticScorerName } from '../scorers.js'
import { AESTHETIC_SCORES_TABLE } from '../scorers.js'
import { placeholders } from '../sql.js'

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

/** 已存的某个 scorer 的分，没有则 `null`。 */
export function getAestheticScore(
  sqlite: BetterSqlite3.Database,
  postId: number,
  scorer: AestheticScorerName,
): number | null {
  const row = sqlite
    .prepare<[number, string], { score: number }>(
      `SELECT score FROM ${AESTHETIC_SCORES_TABLE} WHERE post_id = ? AND scorer = ?`,
    )
    .get(postId, scorer)
  return row?.score ?? null
}
