/**
 * 过滤后的计数与聚合 —— 对应 Python 侧 `PostQueryService` 的 counts/aggregates 段。
 */
import { placeholders, whereSql } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { buildWhere, GROUPABLE_COLUMNS, hasActiveFilters, type PostFilter } from '../filters.js'
import { bucketCaseSql, WAIFU_SCORE_BUCKETS, type ScorerSpec } from '../scorers.js'

export function countPosts(sqlite: BetterSqlite3.Database, f: PostFilter): number {
  const { where, params, joins } = buildWhere(f)
  const row = sqlite
    .prepare<unknown[], { n: number }>(
      `SELECT count(p.id) AS n FROM posts p ${joins.join('\n')} ${whereSql(where)}`,
    )
    .get(...params)
  return row ? Number(row.n) : 0
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

export interface TagCount {
  tag_name: string
  count: number
}

/**
 * 过滤后的 post 里每个 tag 各命中多少 —— tag 过滤器的 facet。
 *
 * tag 是多对多，所以（不像 `countByColumn`）要 JOIN `post_has_tag` 再按 `tag_name`
 * 分组。前端在计数前会把 `tags` 这一项从过滤器里清掉（`filterWithoutSelf`），于是
 * 这个查询回答的是"再加上 tag X 的话还剩多少"。
 *
 * `extraNames` 把 `query` 的匹配面扩宽：控制器把本地化显示名的命中
 * （"绿眼"）解析成 DB 里的 tag 名（`green_eyes`）传进来。一个 tag 只要命中 LIKE
 * **或**落在这个集合里就算匹配 —— 这一层对翻译一无所知。
 */
export function countByTag(
  sqlite: BetterSqlite3.Database,
  f: PostFilter,
  { query = '', limit = 50, extraNames = [] as string[] } = {},
): TagCount[] {
  const { where: clauses, params, joins } = buildWhere(f)

  // 转义 LIKE 的元字符，让搜索框里打的 '%' / '_' 按字面匹配
  // （默认转义符 '\' 自己要先转义）。
  const escapedLike = query
    ? `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    : null

  /** LIKE 与显式名字集合 OR 起来的名字谓词。 */
  function nameMatch(col: string): { sql: string, params: unknown[] } | null {
    const parts: string[] = []
    const p: unknown[] = []
    if (escapedLike !== null) {
      parts.push(`${col} LIKE ? ESCAPE '\\'`)
      p.push(escapedLike)
    }
    if (extraNames.length) {
      parts.push(`${col} IN (${placeholders(extraNames.length)})`)
      p.push(...extraNames)
    }
    return parts.length ? { sql: `(${parts.join(' OR ')})`, params: p } : null
  }

  // 快路径：没有**内容**过滤器，于是每个 tag 的命中数就是它的 canonical 总数，
  // 由触发器维护在 `tags.post_count` 上（触发器只数 canonical post，所以隐藏的
  // 组成员已经被排除了）。走 ix_tags_post_count，而不是每次打开下拉框都对
  // 940 万行的 post_has_tag 做一次 GROUP BY。
  //
  // ⚠️ `only_canonical` 单独成立不会离开快路径 —— 只有真正收窄集合的过滤器
  // （或显式要求包含成员）才会走实时路径。
  if (f.only_canonical !== false && !hasActiveFilters(f)) {
    const fastParams: unknown[] = []
    let sql = 'SELECT name AS tag_name, post_count AS count FROM tags WHERE post_count > 0'
    const fast = nameMatch('name')
    if (fast) {
      sql += ` AND ${fast.sql}`
      fastParams.push(...fast.params)
    }
    sql += ' ORDER BY post_count DESC, name ASC LIMIT ?'
    fastParams.push(limit)
    return sqlite.prepare<unknown[], TagCount>(sql).all(...fastParams)
  }

  // 过滤路径：对 join 实时 GROUP BY。过滤器先把 post 集合收窄，所以扫到的
  // 远少于整张关联表。
  const live = nameMatch('pt.tag_name')
  if (live) {
    clauses.push(live.sql)
    params.push(...live.params)
  }
  params.push(limit) // 最后绑定 —— 对应 LIMIT 里那个结尾的 ?
  return sqlite
    .prepare<unknown[], TagCount>(
      `SELECT pt.tag_name AS tag_name, count(*) AS count `
      + `FROM posts p JOIN post_has_tag pt ON pt.post_id = p.id `
      + `${joins.join('\n')} ${whereSql(clauses)} `
      + `GROUP BY pt.tag_name `
      + `ORDER BY count DESC, pt.tag_name ASC `
      + `LIMIT ?`,
    )
    .all(...params)
}
