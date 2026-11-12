/**
 * 过滤后的计数与聚合 —— 形状承自已退役的 Python 侧 `PostQueryService` 的 counts/aggregates 段。
 */
import { placeholders, whereSql } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { Buffer } from 'node:buffer'
import { buildWhere, GROUPABLE_COLUMNS, hasActiveFilters, type PostFilter } from '../filters.js'
import { bucketCaseSql, type ScorerSpec } from '../scorers.js'
import { COUNT_DRIVE_MAX_POSTS, pickDrivingTag } from './tag-drive.js'

/**
 * 计数类查询的 where：带 tag 过滤时让最冷门的那个 tag 驱动（`IN` 子查询），而不是对
 * 每张 canonical post 做一次 EXISTS 探测。计数没有 LIMIT 可以提前停，所以除非 tag
 * 占了全库的大半，IN 都更快 —— 阈值和实测见 `tag-drive.ts`。
 */
function countWhere(sqlite: BetterSqlite3.Database, f: PostFilter) {
  return buildWhere(f, { drivingTag: pickDrivingTag(sqlite, f.tags, COUNT_DRIVE_MAX_POSTS) })
}

export function countPosts(sqlite: BetterSqlite3.Database, f: PostFilter): number {
  const { where, params, joins } = countWhere(sqlite, f)
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

  const { where, params, joins } = countWhere(sqlite, f)
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
 * ⚠️ **原样返回 GROUP BY 的结果，不零填充也不重排** —— 与 Python 侧一致。没有
 * 任何一条落在某档时，那一档就是不出现（实测 UNSCORED 在全量过滤下就不出现）。
 * 加零填充会多出前端没预期的档位。
 */
export function countByScorerBucket(
  sqlite: BetterSqlite3.Database,
  f: PostFilter,
  scorer: ScorerSpec,
): BucketCount[] {
  const { where, params, joins } = countWhere(sqlite, f)
  const localJoins = [...joins]

  // 整词匹配，别名共享前缀时不能误判
  if (!scorer.isJoined(localJoins))
    localJoins.push(scorer.joinSql())

  const caseSql = bucketCaseSql(scorer.buckets, scorer.scoreCol(), scorer.nullCol())
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
  rating_distribution: Array<{ rating: number, count: number }>
}

/**
 * 底栏用的整体质量统计。
 *
 * 只扫一遍过滤集：按 rating 的 GROUP BY 顺带把 score 的和带出来，再在这里重组成
 * 整体加权均值（total_sum / total_count —— 和分开写 AVG 的结果一致）。
 */
export function aggregateStats(sqlite: BetterSqlite3.Database, f: PostFilter): AggregateStats {
  const { where, params, joins } = countWhere(sqlite, f)
  const rows = sqlite
    .prepare<unknown[], {
      rating: number | null
      count: number
      score_sum: number | null
      scored_count: number
    }>(
      `SELECT
         p.rating AS rating,
         count(*) AS count,
         SUM(CASE WHEN p.score > 0 THEN p.score END) AS score_sum,
         count(CASE WHEN p.score > 0 THEN 1 END) AS scored_count
       FROM posts p ${joins.join('\n')} ${whereSql(where)}
       GROUP BY p.rating`,
    )
    .all(...params)

  const scoredCount = rows.reduce((a, r) => a + Number(r.scored_count), 0)
  const scoreSum = rows.reduce((a, r) => a + (r.score_sum === null ? 0 : Number(r.score_sum)), 0)

  return {
    total: rows.reduce((a, r) => a + Number(r.count), 0),
    avg_score: scoredCount ? scoreSum / scoredCount : null,
    scored_count: scoredCount,
    rating_distribution: rows.map(r => ({ rating: Number(r.rating ?? 0), count: Number(r.count) })),
  }
}

export interface TagCount {
  tag_name: string
  count: number
}

/** `[tag_name, count]`，按 count 降序、tag_name 升序（SQLite BINARY 序 = UTF-8 字节序）。 */
export type TagCountEntry = [string, number]

export interface TagNameMatch {
  query?: string
  limit?: number
  extraNames?: readonly string[]
}

/** 过滤路径的读：每一块之间调一次 `shouldAbort`，返回 true 就抛 `AbortError` 中止。 */
export interface AbortCheck {
  shouldAbort?: () => boolean
  /** 每块多少张 canonical post。只为测试能在小库上走到多块；生产用默认。 */
  chunkPosts?: number
}

/** 每块大约这么多张 post（按 id 区间切）：块之间可以取消。 */
const TAG_COUNT_CHUNK_POSTS = 25_000

const CANONICAL = 'p.canonical_post_id IS NULL'

function abortError(): Error {
  const err = new Error('countAllTags aborted')
  err.name = 'AbortError'
  return err
}

/** SQLite BINARY 排序：UTF-8 字节序。纯 ASCII 时与 JS 的 UTF-16 码元序相同，走快路。 */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/
function compareBinary(a: string, b: string): number {
  if (!NON_ASCII.test(a) && !NON_ASCII.test(b))
    return a < b ? -1 : a > b ? 1 : 0
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** SQLite 的 LIKE 只对 ASCII 字母做大小写折叠。 */
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, c => c.toLowerCase())
}

/**
 * 在 `countAllTags` 的全量结果上按名字筛、取前 `limit` 个 —— 与原来 SQL 里的
 * `LIKE '%q%' ESCAPE '\' OR tag_name IN (extraNames)` + `ORDER BY count DESC, tag_name ASC LIMIT ?`
 * 逐条等价（LIKE 转义后就是子串包含，只折叠 ASCII 大小写）。
 *
 * 搬到这一侧是为了缓存：全量结果按过滤签名缓存一次，搜索框里每敲一个字只是在内存里
 * 再筛一遍，而不是对过滤集的全部标签行再 GROUP BY 一次（真库 1–30 s）。
 */
export function selectTagCounts(
  all: readonly TagCountEntry[],
  { query = '', limit = 50, extraNames = [] }: TagNameMatch = {},
): TagCount[] {
  const needle = query ? lowerAscii(query) : null
  const extra = extraNames.length ? new Set(extraNames) : null
  const out: TagCount[] = []
  for (const [name, count] of all) {
    if (out.length >= limit)
      break
    if (needle !== null || extra !== null) {
      const hit = (needle !== null && lowerAscii(name).includes(needle)) || (extra?.has(name) ?? false)
      if (!hit)
        continue
    }
    out.push({ tag_name: name, count })
  }
  return out
}

/**
 * 对 `clauses` 圈定的一组 post 数每个 tag 出现几次，按 id 区间分块（块间可取消），
 * 结果乘 `sign` 累加进 `into`。
 *
 * 写成 `pt.post_id IN (SELECT p.id ...)` 而不是 `posts JOIN post_has_tag`：同样的行，外层
 * 只剩 post_has_tag 一张表，真库实测快 2 倍多（rating=4：2.5 s → 1.1 s）。
 */
function countTagsOver(
  sqlite: BetterSqlite3.Database,
  clauses: string[],
  params: unknown[],
  joins: string[],
  bounds: readonly number[],
  into: Map<string, number>,
  sign: 1 | -1,
  shouldAbort: () => boolean,
): void {
  const stmt = sqlite
    .prepare<unknown[], [string, number]>(
      `SELECT pt.tag_name, count(*) FROM post_has_tag pt WHERE pt.post_id IN (`
      + `SELECT p.id FROM posts p ${joins.join(' ')} ${whereSql([...clauses, 'p.id >= ?', 'p.id < ?'])}`
      + `) GROUP BY pt.tag_name`,
    )
    .raw()
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (shouldAbort())
      throw abortError()
    for (const [name, n] of stmt.all(...params, bounds[i], bounds[i + 1]))
      into.set(name, (into.get(name) ?? 0) + sign * n)
  }
}

/**
 * 分块边界：canonical post 每 `TAG_COUNT_CHUNK_POSTS` 张一块（id 分布很偏 —— 真库大半
 * 的 id 挤在最后 10% 的区间里，按 id 等宽切会让最后一块独占几秒）。沿
 * `ix_posts_canonical`（覆盖 (canonical_post_id, rowid)）跳，每个边界不到 1 ms。
 * 首尾是 -∞ / +∞，组成员也落在这些区间里。
 */
function chunkBounds(sqlite: BetterSqlite3.Database, chunkPosts: number): number[] {
  const next = sqlite
    .prepare<[number], number>(
      `SELECT id FROM posts INDEXED BY ix_posts_canonical WHERE ${CANONICAL.replace('p.', '')} AND id > ? ORDER BY id LIMIT 1 OFFSET ${Math.max(1, Math.trunc(chunkPosts)) - 1}`,
    )
    .pluck()
  const bounds = [Number.MIN_SAFE_INTEGER]
  for (let b = next.get(Number.MIN_SAFE_INTEGER); b !== undefined; b = next.get(b))
    bounds.push(b)
  bounds.push(Number.MAX_SAFE_INTEGER)
  return bounds
}

/**
 * 过滤集里每个 tag 的命中数（全量、已排序）—— `countByTag` 过滤路径的本体；`apps/api`
 * 按过滤签名缓存它（`read-cache.ts`），按名字筛 / 取前 N 交给 `selectTagCounts`。
 *
 * 补集：命中集合占了 canonical 的大半时，改数**补集**（canonical 里不满足过滤的那些），
 * 再用 `tags.post_count`（触发器维护的 canonical 计数，快路径用的也是它）减掉。代价从
 * ∝ 命中数变成 ∝ min(命中数, canonical − 命中数)。`onlyCanonical: false` 拆成 canonical
 * 部分（同上）+ 组成员部分（直接数，成员只有几万张）。
 */
export function countAllTags(
  sqlite: BetterSqlite3.Database,
  f: PostFilter,
  { shouldAbort = () => false, chunkPosts = TAG_COUNT_CHUNK_POSTS }: AbortCheck = {},
): TagCountEntry[] {
  const { where, params, joins } = countWhere(sqlite, f)
  // canonical 子句没有绑定参数，摘掉它不会让 params 错位。
  const content = where.filter(c => c !== CANONICAL)
  const counts = new Map<string, number>()
  const bounds = chunkBounds(sqlite, chunkPosts)

  const canonicalTotal = sqlite.prepare<[], number>(`SELECT count(*) FROM posts p WHERE ${CANONICAL}`).pluck().get()!
  const canonicalHits = content.length
    ? sqlite
        .prepare<unknown[], number>(`SELECT count(*) FROM posts p ${joins.join('\n')} ${whereSql([CANONICAL, ...content])}`)
        .pluck()
        .get(...params)!
    : canonicalTotal

  if (canonicalHits * 2 > canonicalTotal) {
    for (const [name, n] of sqlite.prepare<[], [string, number]>('SELECT name, post_count FROM tags WHERE post_count > 0').raw().all())
      counts.set(name, n)
    if (content.length) {
      // NOT COALESCE：过滤子句可能求出 NULL（LEFT JOIN 的分数列），NULL 在原查询里是“不命中”。
      countTagsOver(sqlite, [CANONICAL, `NOT COALESCE((${content.join(' AND ')}), 0)`], params, joins, bounds, counts, -1, shouldAbort)
    }
  }
  else if (canonicalHits > 0) {
    countTagsOver(sqlite, [CANONICAL, ...content], params, joins, bounds, counts, 1, shouldAbort)
  }

  if (f.onlyCanonical === false)
    countTagsOver(sqlite, ['p.canonical_post_id IS NOT NULL', ...content], params, joins, bounds, counts, 1, shouldAbort)

  const all: TagCountEntry[] = []
  for (const [name, n] of counts) {
    if (n > 0)
      all.push([name, n])
  }
  all.sort((a, b) => b[1] - a[1] || compareBinary(a[0], b[0]))
  return all
}

/**
 * 没有**内容**过滤器：每个 tag 的命中数就是它的 canonical 总数，由触发器维护在
 * `tags.post_count` 上（触发器只数 canonical post，所以隐藏的组成员已经被排除了）。
 *
 * ⚠️ `onlyCanonical` 单独成立不会离开快路径 —— 只有真正收窄集合的过滤器
 * （或显式要求包含成员）才会走实时路径。
 */
export function isTagCountFastPath(f: PostFilter): boolean {
  return f.onlyCanonical !== false && !hasActiveFilters(f)
}

/** 快路径：走 ix_tags_post_count，而不是每次打开下拉框都对 2400 万行的 post_has_tag 做 GROUP BY。 */
export function countByTagFast(
  sqlite: BetterSqlite3.Database,
  { query = '', limit = 50, extraNames = [] }: TagNameMatch = {},
): TagCount[] {
  const parts: string[] = []
  const p: unknown[] = []
  if (query) {
    // 转义 LIKE 的元字符，让搜索框里打的 '%' / '_' 按字面匹配（默认转义符 '\' 自己要先转义）。
    parts.push(`name LIKE ? ESCAPE '\\'`)
    p.push(`%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
  }
  if (extraNames.length) {
    parts.push(`name IN (${placeholders(extraNames.length)})`)
    p.push(...extraNames)
  }
  let sql = 'SELECT name AS tag_name, post_count AS count FROM tags WHERE post_count > 0'
  if (parts.length)
    sql += ` AND (${parts.join(' OR ')})`
  sql += ' ORDER BY post_count DESC, name ASC LIMIT ?'
  return sqlite.prepare<unknown[], TagCount>(sql).all(...p, limit)
}

/**
 * 过滤后的 post 里每个 tag 各命中多少 —— tag 过滤器的 facet。
 *
 * 前端在计数前会把 `tags` 这一项从过滤器里清掉（`filterWithoutSelf`），于是这个查询
 * 回答的是"再加上 tag X 的话还剩多少"。
 *
 * `extraNames` 把 `query` 的匹配面扩宽：控制器把本地化显示名的命中
 * （"绿眼"）解析成 DB 里的 tag 名（`green_eyes`）传进来。一个 tag 只要命中 LIKE
 * **或**落在这个集合里就算匹配 —— 这一层对翻译一无所知。
 */
export function countByTag(
  sqlite: BetterSqlite3.Database,
  f: PostFilter,
  { query = '', limit = 50, extraNames = [] as readonly string[] }: TagNameMatch = {},
): TagCount[] {
  if (isTagCountFastPath(f))
    return countByTagFast(sqlite, { query, limit, extraNames })
  return selectTagCounts(countAllTags(sqlite, f), { query, limit, extraNames })
}
