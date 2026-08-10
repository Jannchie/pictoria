/**
 * 过滤后的计数与聚合 —— 对应 Python 侧 `PostQueryService` 的 counts/aggregates 段。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { buildWhere, GROUPABLE_COLUMNS, type PostFilter } from '../filters.js'
import { bucketCaseSql, WAIFU_SCORE_BUCKETS, type ScorerSpec } from '../scorers.js'

/** `WHERE a AND b`，没有子句时是空串。 */
function whereSql(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

export function countPosts(sqlite: BetterSqlite3.Database, f: PostFilter): number {
  const { where, params, joins } = buildWhere(f)
  const row = sqlite
    .prepare<unknown[], { n: number }>(
      `SELECT count(p.id) AS n FROM posts p ${joins.join('\n')} ${whereSql(where)}`,
    )
    .get(...params)
  return row ? Number(row.n) : 0
}

export interface ColumnCount {
  [column: string]: number
}

/**
 * 按某一列分组计数。
 *
 * `column` 必须在 `GROUPABLE_COLUMNS` 白名单里 —— 它会被拼进 SQL，白名单是这里
 * 唯一的注入防线。
 */
export function countByColumn(
  sqlite: BetterSqlite3.Database,
  column: string,
  f: PostFilter,
): Array<Record<string, number>> {
  if (!GROUPABLE_COLUMNS.has(column))
    throw new Error(`Cannot group by unsafe column: ${column}`)

  const { where, params, joins } = buildWhere(f)
  return sqlite
    .prepare<unknown[], Record<string, number>>(
      `SELECT p.${column} AS ${column}, count(*) AS count `
      + `FROM posts p ${joins.join('\n')} ${whereSql(where)} GROUP BY p.${column}`,
    )
    .all(...params)
}

export interface BucketCount {
  bucket: string
  count: number
}

/**
 * 按分档计数（A–E，以及全部未评分时的 UNSCORED）。
 *
 * `scorer` 为 null 时统计 waifu（独立的 post_waifu_scores 表），否则统计
 * post_aesthetic_scores 里的对应打分器。
 *
 * ⚠️ **原样返回 GROUP BY 的结果，不零填充也不重排** —— 与 Python 侧一致。没有
 * 任何一条落在某档时，那一档就是不出现（实测 UNSCORED 在全量过滤下就不出现）。
 * 加零填充会多出前端没预期的档位。
 */
export function countByScorerBucket(
  sqlite: BetterSqlite3.Database,
  f: PostFilter,
  scorer: ScorerSpec | null,
): BucketCount[] {
  const { where, params, joins } = buildWhere(f)
  const localJoins = [...joins]

  let scoreCol: string
  let nullCol: string
  let buckets

  if (scorer === null) {
    if (!localJoins.some(j => j.includes('post_waifu_scores')))
      localJoins.push('LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id')
    scoreCol = 'pws.score'
    nullCol = 'pws.post_id'
    buckets = WAIFU_SCORE_BUCKETS
  }
  else {
    // 整词匹配，别名共享前缀时（pas_silva ⊂ pas_silva_luna）不能误判
    if (!scorer.isJoined(localJoins))
      localJoins.push(scorer.joinSql())
    scoreCol = scorer.scoreCol()
    nullCol = scorer.nullCol()
    buckets = scorer.buckets
  }

  const caseSql = bucketCaseSql(buckets, scoreCol, nullCol)
  const rows = sqlite
    .prepare<unknown[], { bucket: string, count: number }>(
      `SELECT ${caseSql} AS bucket, count(*) AS count `
      + `FROM posts p ${localJoins.join('\n')} ${whereSql(where)} GROUP BY bucket`,
    )
    .all(...params)

  return rows.map(r => ({ bucket: r.bucket, count: Number(r.count) }))
}

export interface AggregateStats {
  total: number
  avg_score: number | null
  scored_count: number
  avg_waifu_score: number | null
  waifu_count: number
  rating_distribution: Array<{ rating: number, count: number }>
}

/**
 * 底栏用的整体质量统计。
 *
 * 只扫一遍过滤集：按 rating 的 GROUP BY 顺带把 score / waifu 的和带出来，再在
 * 这里重组成整体加权均值（total_sum / total_count —— 和分开写 AVG 的结果一致）。
 * `post_waifu_scores` 按主键 1:1 join，LEFT JOIN 不会让行数翻倍。
 */
export function aggregateStats(sqlite: BetterSqlite3.Database, f: PostFilter): AggregateStats {
  const { where, params, joins } = buildWhere(f)
  const localJoins = [...joins]
  if (!localJoins.some(j => j.includes('post_waifu_scores')))
    localJoins.push('LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id')

  const rows = sqlite
    .prepare<unknown[], {
      rating: number | null
      count: number
      score_sum: number | null
      scored_count: number
      waifu_sum: number | null
      waifu_count: number
    }>(
      `SELECT
         p.rating AS rating,
         count(*) AS count,
         SUM(CASE WHEN p.score > 0 THEN p.score END) AS score_sum,
         count(CASE WHEN p.score > 0 THEN 1 END) AS scored_count,
         SUM(pws.score) AS waifu_sum,
         count(pws.post_id) AS waifu_count
       FROM posts p ${localJoins.join('\n')} ${whereSql(where)}
       GROUP BY p.rating`,
    )
    .all(...params)

  const scoredCount = rows.reduce((a, r) => a + Number(r.scored_count), 0)
  const scoreSum = rows.reduce((a, r) => a + (r.score_sum === null ? 0 : Number(r.score_sum)), 0)
  const waifuCount = rows.reduce((a, r) => a + Number(r.waifu_count), 0)
  const waifuSum = rows.reduce((a, r) => a + (r.waifu_sum === null ? 0 : Number(r.waifu_sum)), 0)

  return {
    total: rows.reduce((a, r) => a + Number(r.count), 0),
    avg_score: scoredCount ? scoreSum / scoredCount : null,
    scored_count: scoredCount,
    avg_waifu_score: waifuCount ? waifuSum / waifuCount : null,
    waifu_count: waifuCount,
    rating_distribution: rows.map(r => ({ rating: Number(r.rating ?? 0), count: Number(r.count) })),
  }
}
