/**
 * 列表与搜索 —— 形状承自已退役的 Python 侧 `PostQueryService.list_paginated` / `search`。
 */
import { placeholders, whereSql } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { Buffer } from 'node:buffer'
import { buildWhere, type BuildWhereOptions, ORDERABLE_COLUMNS, type PostFilter } from '../filters.js'
import { LIST_DRIVE_MAX_POSTS, pickDrivingTag } from './tag-drive.js'
import { FILTERABLE_SCORERS, orderColumn, SILVA } from '../scorers.js'
import { SIGLIP2_TABLE } from '../repositories/vectors.js'
import {
  decodeDominantColor,
  fetchAestheticByIds,
  fetchColorsByIds,
  fetchTagsByIds,
  fetchWaifuByIds,
  memberCounts,
  POST_COLUMNS,
  SIMPLE_BASE_COLUMNS,
  SIMPLE_POST_COLUMNS,
  type PostDetail,
} from './post-detail.js'

/** 带 `p.` 前缀的 SELECT 列表（搜索路径用）。 */
const SIMPLE_BASE_SELECT = SIMPLE_BASE_COLUMNS.map(c => `p.${c}`).join(', ')

/** 解析成 join 表达式而不是 `p.<col>` 的排序列。 */
const VIRTUAL_SORT_COLUMNS = new Set<string>([...FILTERABLE_SCORERS.map(orderColumn), 'discrepancy'])

export interface PostFilterWithOrder extends PostFilter {
  orderBy?: string | null
  order?: 'asc' | 'desc' | 'random' | null
  orderSeed?: number | null
  sortDirection?: 'asc' | 'desc' | null
}

/** 小于 2^31 且 ≡ 2 (mod 3) 的素数：x → x³ 在其上是双射，乘积不溢出 int64。 */
const SHUFFLE_PRIME = 2147483579
const SHUFFLE_MULTIPLIER = 1640531527

/**
 * `order='random'` 的种子洗牌键：`x = (id·A + seed) mod P`，再取 `x³ mod P`。
 *
 * 不能用 `(id * seed) % P` 这种线性哈希：按它排序时相邻结果的 id 差只有三种取值
 * （三距离定理），翻出来的是等差的 id 序列，同一批导入的图会成片地规律出现。
 * 立方是非线性的，相邻 id 差的分布与真随机一致。种子是校验过的整数，直接内联。
 */
function seededShuffleKey(orderSeed: number | null | undefined): string {
  const P = SHUFFLE_PRIME
  const seed = ((Math.trunc(orderSeed || 1) % P) + P) % P
  // 先乘 A 把 x 撒满 [0, P)：否则种子很小时 id+seed 的立方还不到 P，排出来就是 id 序。
  const x = `(((p.id % ${P}) * ${SHUFFLE_MULTIPLIER} + ${seed}) % ${P})`
  return `(((${x} * ${x}) % ${P}) * ${x} % ${P})`
}

/** sqlite-vec 的 serialize_float32：小端 float32 blob。 */
function serializeFloat32(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}

/**
 * 把虚拟排序列解析成 `(extra_joins, select_expr, order_expr)`。
 *
 * `select_expr` 以 `_sort_col` 暴露在 SELECT 列表里；`order_expr` 是普通（非随机）
 * ORDER BY 真正排的东西（直接是 join 上来的分数，或算出来的 discrepancy 用 `_sort_col`）。
 */
function resolveVirtualSort(
  orderBy: string,
  joins: string[],
): { extra: string[], selectExpr: string, orderExpr: string } {
  const extra: string[] = []
  // 按 `<name>_score` 排序对每个打分器都是同一件事：确保它的 join 在，然后拿它的
  // 分数列。三个手写分支（其中 waifu 那份还用的是裸子串判 join）收成一次查表。
  const spec = FILTERABLE_SCORERS.find(s => orderColumn(s) === orderBy)
  if (spec) {
    if (!spec.isJoined(joins))
      extra.push(spec.joinSql())
    return { extra, selectExpr: spec.scoreCol(), orderExpr: spec.scoreCol() }
  }

  // 剩下的只有 discrepancy —— 它不属于任何一个打分器（是模型分与人工分的差），
  // 所以它是这里唯一真正的特例，挂在 SILVA 的 join 上。
  if (!SILVA.isJoined(joins))
    extra.push(SILVA.joinSql())

  // discrepancy：模型分与人工分在 1–5 标度上的绝对差；没有人工分（0/NULL）或没有
  // silva 分时为 NULL（排到最后）。
  const expr = `CASE WHEN p.score >= 1 AND ${SILVA.scoreCol()} IS NOT NULL THEN ABS(${SILVA.scoreExpr()} - p.score) END`
  return { extra, selectExpr: expr, orderExpr: '_sort_col' }
}

/**
 * 拼出 search 的 SQL 和绑定参数。
 *
 * 三种排序模式都在这里：`lab` 的距离排序、`random`（种子哈希 + 可选的外层按列重排）、
 * 以及普通的列/分数排序。
 */
export function buildSearchQuery(
  f: PostFilterWithOrder,
  limit: number,
  offset: number,
  whereOpts?: BuildWhereOptions,
): { sql: string, params: unknown[] } {
  const { where, params, joins } = buildWhere(f, whereOpts)
  const wSql = whereSql(where)
  let selectCols = `SELECT ${SIMPLE_BASE_SELECT}`

  if (f.lab != null) {
    const fromClause = `FROM posts p${joins.length ? `\n${joins.join('\n')}` : ''}`
    const labBlob = serializeFloat32([...f.lab])
    const sql
      = `${selectCols}, vec_distance_L2(p.dominant_color, ?) AS _dist `
        + `${fromClause} `
        + `${wSql ? `${wSql} AND ` : 'WHERE '}`
        + `p.dominant_color IS NOT NULL `
        + `ORDER BY _dist `
        + `LIMIT ? OFFSET ?`
    return { sql, params: [labBlob, ...params, limit, offset] }
  }

  const extraJoins: string[] = []
  let orderSql = ''
  let resortSql = ''
  const sortable = Boolean(f.orderBy) && ORDERABLE_COLUMNS.has(f.orderBy!)

  if (f.order === 'random') {
    orderSql = `ORDER BY ${seededShuffleKey(f.orderSeed)}, p.id`
    if (sortable) {
      // 种子哈希决定主序；请求的列变成对 `_sort_col` 的外层重排。
      let selectExpr: string
      if (VIRTUAL_SORT_COLUMNS.has(f.orderBy!)) {
        const v = resolveVirtualSort(f.orderBy!, joins)
        extraJoins.push(...v.extra)
        selectExpr = v.selectExpr
      }
      else {
        selectExpr = `p.${f.orderBy}`
      }
      selectCols += `, ${selectExpr} AS _sort_col`
      const resortDir = f.sortDirection === 'asc' ? 'ASC' : 'DESC'
      resortSql = `ORDER BY _sort_col ${resortDir} NULLS LAST`
    }
  }
  else if (sortable) {
    const direction = f.order === 'asc' ? 'ASC' : 'DESC'
    // 唯一的次序键，让 offset 分页稳定：排序列上打平的行（score/rating 大量重复、
    // NULL 成片）否则顺序是任意的，翻页之间会变。
    const tiebreak = f.orderBy === 'id' ? '' : `, p.id ${direction}`
    if (VIRTUAL_SORT_COLUMNS.has(f.orderBy!)) {
      const v = resolveVirtualSort(f.orderBy!, joins)
      extraJoins.push(...v.extra)
      selectCols += `, ${v.selectExpr} AS _sort_col`
      orderSql = `ORDER BY ${v.orderExpr} ${direction} NULLS LAST${tiebreak}`
    }
    else {
      if (f.orderBy !== 'id')
        selectCols += `, p.${f.orderBy} AS _sort_col`
      orderSql = `ORDER BY p.${f.orderBy} ${direction}${tiebreak}`
    }
  }

  const allJoins = [...joins, ...extraJoins]
  const fromClause = `FROM posts p${allJoins.length ? `\n${allJoins.join('\n')}` : ''}`
  const sql = resortSql
    ? `SELECT * FROM (${selectCols} ${fromClause} ${wSql} ${orderSql} LIMIT ? OFFSET ?) ${resortSql}`
    : `${selectCols} ${fromClause} ${wSql} ${orderSql} LIMIT ? OFFSET ?`

  return { sql, params: [...params, limit, offset] }
}

interface SqlAndParams { sql: string, params: unknown[] }

/**
 * 分数类排序（`<scorer>_score` / `discrepancy`，非随机、无 `lab`）的分段计划。
 *
 * 单条 `LEFT JOIN 分数表 ... ORDER BY 分数 NULLS LAST` 的问题：排序列在 LEFT JOIN 的
 * 右表上，planner 不能从右表驱动，只能把命中的 post 全部 join 一遍再 TEMP B-TREE 排序
 * （真库 37.5 万 posts：120–580 ms，深页数秒）。这里把同一个结果序拆成两段：
 *
 *   1. `scored`：有排序值的那段。打分器排序从分数表的 `(scorer, score, post_id)` 索引
 *      驱动（0023 迁移），沿索引凑满 LIMIT 就停；
 *   2. `unscored`：排序值为 NULL 的那段（`NULLS LAST` 的尾巴），按 `p.id` 同向排。
 *
 * 两段拼起来与原 `ORDER BY v DIR NULLS LAST, p.id DIR` 逐行相同（`post-search-sort.test.ts`
 * 对拍）。offset 落在第二段时，第一段的行数由 `countScored` 给出（只有第一段一行都没取到
 * 时才需要数 —— 取到 k 行就说明第一段一共 offset + k 行）。
 *
 * ⚠️ 沿分数索引走只在过滤**宽**时赢：过滤很窄（尤其是按另一个打分器的分档过滤，和排序
 * 列强相关）时要把整条索引走完，每行三次随机点查，真库实测 3–5 s，而原查询顺序扫 posts
 * 只要 300 ms。所以第一段先限在索引的前 `budget` 项里找（`scored(budget)`）：凑满了就是
 * 精确结果（前 offset+limit 个命中必然都在这个前缀里）；没凑满且前缀已经是整条索引，
 * 第一段也是精确的；否则说明过滤太窄，交还给原查询（`fallback`）。最坏情况是多付一次
 * 有界的探测（1 万项约 10–25 ms）。
 *
 * discrepancy 没法走索引（它是两张表的列算出来的），但“有值”的前提是 `p.score >= 1`，
 * 由 `ix_posts_score` 的范围驱动，不需要预算。
 */
export interface ScoreSortPlan {
  /** `budget` 为 null 时不限（discrepancy 恒为不限）。 */
  scored: (budget: number | null) => SqlAndParams
  /** 索引驱动时：分数表这个打分器第 `budget` 项是否存在（不存在 = 前缀即全表）。 */
  hasMoreThan: ((budget: number) => SqlAndParams) | null
  countScored: SqlAndParams
  unscored: (limit: number, offset: number) => SqlAndParams
}

/** 候选集不超过它就不走分段计划（原查询从小集合驱动再排序更快）。 */
export const SCORE_SORT_SMALL_SET = 20_000

function isScoreSort(f: PostFilterWithOrder): boolean {
  return f.lab == null && f.order !== 'random' && Boolean(f.orderBy) && VIRTUAL_SORT_COLUMNS.has(f.orderBy!)
}

/** 文件夹过滤命中不超过 `SCORE_SORT_SMALL_SET` 个 post（有界计数，最多走 2 万项索引）。 */
function isSmallFolder(sqlite: BetterSqlite3.Database, folder: string | null | undefined): boolean {
  if (!folder || folder === '.')
    return false
  const n = sqlite
    .prepare<unknown[], number>(
      'SELECT COUNT(*) FROM (SELECT 1 FROM posts WHERE file_path = ? OR (file_path >= ? AND file_path < ?) LIMIT ?)',
    )
    .pluck()
    .get(folder, `${folder}/`, `${folder}0`, SCORE_SORT_SMALL_SET + 1)!
  return n <= SCORE_SORT_SMALL_SET
}

/** 索引驱动的探测预算：至少 1 万项，深页按需要的行数放大。 */
export const SCORE_SORT_MIN_BUDGET = 10_000
const SCORE_SORT_BUDGET_FACTOR = 20

export function buildScoreSortPlan(
  f: PostFilterWithOrder,
  whereOpts?: BuildWhereOptions,
): ScoreSortPlan | null {
  if (!isScoreSort(f))
    return null

  const { where, params, joins } = buildWhere(f, whereOpts)
  const direction = f.order === 'asc' ? 'ASC' : 'DESC'
  const isDiscrepancy = f.orderBy === 'discrepancy'
  const spec = isDiscrepancy ? SILVA : FILTERABLE_SCORERS.find(s => orderColumn(s) === f.orderBy)!

  const leftJoin = spec.joinSql()
  const otherJoins = joins.filter(j => j !== leftJoin)
  // 第二段：保留 LEFT JOIN，取排序值为 NULL 的行。
  const unscoredJoins = spec.isJoined(joins) ? joins : [...joins, leftJoin]
  const unscoredWhere = isDiscrepancy
    ? `NOT COALESCE(p.score >= 1 AND ${SILVA.nullCol()} IS NOT NULL, 0)`
    : `${spec.nullCol()} IS NULL`
  const unscored = (lim: number, off: number): SqlAndParams => ({
    sql: `SELECT ${SIMPLE_BASE_SELECT}, NULL AS _sort_col FROM posts p\n${unscoredJoins.join('\n')} `
      + `${whereSql([...where, unscoredWhere])} ORDER BY p.id ${direction} LIMIT ? OFFSET ?`,
    params: [...params, lim, off],
  })

  if (isDiscrepancy) {
    const sortExpr = `ABS(${SILVA.scoreExpr()} - p.score)`
    const innerJoin = leftJoin.replace(/^LEFT JOIN /, 'JOIN ')
    const from = `FROM posts p\n${[innerJoin, ...otherJoins].join('\n')} ${whereSql([...where, 'p.score >= 1'])}`
    return {
      scored: () => ({
        sql: `SELECT ${SIMPLE_BASE_SELECT}, ${sortExpr} AS _sort_col ${from} `
          + `ORDER BY _sort_col ${direction}, p.id ${direction} LIMIT ? OFFSET ?`,
        params,
      }),
      hasMoreThan: null,
      countScored: { sql: `SELECT COUNT(*) ${from}`, params },
      unscored,
    }
  }

  // 分数表的这一段：别名沿用打分器自己的别名，过滤里引用它的子句（分档、waifu 区间）
  // 照样成立，`<alias>.post_id IS NULL` 分支在这一段里恒假，与原语义一致。
  const table = leftJoin.slice('LEFT JOIN '.length).split(' ')[0]!
  const a = spec.alias
  const scope = leftJoin.includes(`${a}.scorer = `) ? `WHERE ${a}.scorer = '${spec.name}' ` : ''
  const indexOrder = `ORDER BY ${a}.score ${direction}, ${a}.post_id ${direction}`
  const source = (budget: number | null) =>
    `(SELECT ${a}.post_id, ${a}.score FROM ${table} ${a} ${scope}${indexOrder}${budget == null ? '' : ` LIMIT ${Math.trunc(budget)}`}) ${a}`
  const from = (budget: number | null) =>
    `FROM ${source(budget)}\nJOIN posts p ON p.id = ${a}.post_id${otherJoins.length ? `\n${otherJoins.join('\n')}` : ''} ${whereSql(where)}`
  return {
    scored: budget => ({
      sql: `SELECT ${SIMPLE_BASE_SELECT}, ${a}.score AS _sort_col ${from(budget)} ${indexOrder} LIMIT ? OFFSET ?`,
      params,
    }),
    hasMoreThan: budget => ({
      sql: `SELECT 1 FROM ${table} ${a} ${scope}${indexOrder} LIMIT 1 OFFSET ${Math.trunc(budget)}`,
      params: [],
    }),
    countScored: { sql: `SELECT COUNT(*) ${from(null)}`, params },
    unscored,
  }
}

/**
 * 执行 `buildScoreSortPlan`：先取有排序值的一段，不够再接 NULL 尾巴。返回 null 表示
 * 预算内没凑满、交还给原查询。
 */
export function runScoreSortPlan(
  sqlite: BetterSqlite3.Database,
  plan: ScoreSortPlan,
  limit: number,
  offset: number,
  budget: number | null,
): Array<Record<string, unknown>> | null {
  const all = (q: SqlAndParams, ...extra: unknown[]) =>
    sqlite.prepare<unknown[], Record<string, unknown>>(q.sql).all(...q.params, ...extra)
  const effectiveBudget = plan.hasMoreThan ? budget : null
  const rows = all(plan.scored(effectiveBudget), limit, offset)
  if (rows.length >= limit)
    return rows
  if (effectiveBudget != null) {
    const more = plan.hasMoreThan!(effectiveBudget)
    if (sqlite.prepare(more.sql).get(...more.params) !== undefined)
      return null
  }
  // 第一段取到了 k 行（k < limit）：它一共 offset + k 行，第二段从 0 开始。
  // 一行没取到：offset 越过了第一段，得数一下第一段有多少行才知道第二段的 offset。
  const scoredTotal = rows.length > 0
    ? offset + rows.length
    : (offset > 0
        ? sqlite.prepare<unknown[], number>(plan.countScored.sql).pluck().get(...plan.countScored.params)!
        : 0)
  rows.push(...all(plan.unscored(limit - rows.length, Math.max(0, offset - scoredTotal))))
  return rows
}

/** 搜索，返回可直接喂给 `PostSimplePublic` 的行。 */
export function searchPosts(
  sqlite: BetterSqlite3.Database,
  f: PostFilterWithOrder,
  { limit = 100, offset = 0 }: { limit?: number, offset?: number } = {},
): Array<Record<string, unknown>> {
  const scoreSort = isScoreSort(f)
  // 冷门 tag 从 tag 侧驱动（见 `tag-drive.ts`）；SQL 文本只在选中时才变，golden 不受影响。
  // 分数排序的阈值更高：原查询无论如何要整库排序，从 tag 取 2 万张以内再排序反而便宜。
  const drivingTag = pickDrivingTag(sqlite, f.tags, scoreSort ? SCORE_SORT_SMALL_SET : LIST_DRIVE_MAX_POSTS)
  // 候选集本来就小（冷门 tag、小文件夹）时原查询从那一侧驱动只要几毫秒，探测预算反而是白付。
  const plan = scoreSort && !drivingTag && !isSmallFolder(sqlite, f.folder)
    ? buildScoreSortPlan(f)
    : null
  const budget = Math.max(SCORE_SORT_MIN_BUDGET, (offset + limit) * SCORE_SORT_BUDGET_FACTOR)
  let rows = plan ? runScoreSortPlan(sqlite, plan, limit, offset, budget) : null
  if (!rows) {
    const { sql, params } = buildSearchQuery(f, limit, offset, { drivingTag })
    rows = sqlite.prepare<unknown[], Record<string, unknown>>(sql).all(...params)
  }

  for (const r of rows) {
    // `_dist` 是排序用的内部列，直接丢掉。
    delete r._dist
    // `_sort_col` 则**总是**变成 sort_value（没有时是 null）—— 网格靠它给每个
    // 条目标注当前排序依据。按 id 或 lab 排序时自然就是 null。
    const sortValue = r._sort_col
    delete r._sort_col
    r.sort_value = sortValue === undefined ? null : sortValue
    r.dominant_color = decodeDominantColor(r.dominant_color)
  }

  const ids = rows.map(r => r.id as number)
  const colors = fetchColorsByIds(sqlite, ids)
  const counts = memberCounts(sqlite, ids)
  for (const r of rows) {
    r.colors = colors.get(r.id as number) ?? []
    r.group_member_count = counts.get(r.id as number) ?? 0
  }
  return rows
}

export interface PaginatedPosts {
  items: PostDetail[]
  nextCursor: number | null
}

/**
 * 按 id 游标分页列出 canonical post，附带全部关联。
 *
 * 多取一条来判断有没有下一页 —— 比再发一次 count 便宜。
 */
export function listPaginated(
  sqlite: BetterSqlite3.Database,
  start: number,
  limit: number,
  translate: (name: string) => string | null,
): PaginatedPosts {
  const posts = sqlite
    .prepare<[number, number], Record<string, unknown>>(
      `SELECT ${POST_COLUMNS} FROM posts `
      + `WHERE id >= ? AND canonical_post_id IS NULL ORDER BY id ASC LIMIT ?`,
    )
    .all(start, limit + 1)

  for (const p of posts) p.dominant_color = decodeDominantColor(p.dominant_color)

  let nextCursor: number | null = null
  let page = posts
  if (posts.length > limit) {
    nextCursor = posts[posts.length - 1]!.id as number
    page = posts.slice(0, -1)
  }

  const ids = page.map(p => p.id as number)
  const tags = fetchTagsByIds(sqlite, ids, translate)
  const colors = fetchColorsByIds(sqlite, ids)
  const waifu = fetchWaifuByIds(sqlite, ids)
  const aesthetic = fetchAestheticByIds(sqlite, ids)
  const counts = memberCounts(sqlite, ids)

  const items = page.map(p => ({
    ...p,
    tags: tags.get(p.id as number) ?? [],
    colors: colors.get(p.id as number) ?? [],
    waifu_score: waifu.get(p.id as number) ?? null,
    aesthetic_scores: aesthetic.get(p.id as number) ?? [],
    group_member_count: counts.get(p.id as number) ?? 0,
  })) as PostDetail[]

  return { items, nextCursor }
}

/**
 * 按 `idList` 的顺序返回 PostSimplePublic 形状的行。
 *
 * `onlyCanonical=true` 会把近重复成员从结果里去掉 —— 相似图搜索用它，免得被隐藏的
 * 成员漏进网格（只有它们的 canonical 代表该出现）。
 */
export function listSimpleByIdsPreservingOrder(
  sqlite: BetterSqlite3.Database,
  idList: number[],
  { onlyCanonical = false }: { onlyCanonical?: boolean } = {},
): Array<Record<string, unknown>> {
  if (!idList.length)
    return []

  const rows = sqlite
    .prepare<unknown[], Record<string, unknown>>(
      `SELECT ${SIMPLE_POST_COLUMNS} FROM posts WHERE id IN (${placeholders(idList.length)})`,
    )
    .all(...idList)

  for (const r of rows) r.dominant_color = decodeDominantColor(r.dominant_color)

  const byId = new Map(rows.map(r => [r.id as number, r]))
  let ordered = idList.map(i => byId.get(i)).filter((r): r is Record<string, unknown> => r !== undefined)
  if (onlyCanonical)
    ordered = ordered.filter(r => r.canonical_post_id === null)

  const ids = ordered.map(r => r.id as number)
  const colors = fetchColorsByIds(sqlite, ids)
  const counts = memberCounts(sqlite, ids)
  for (const r of ordered) {
    r.colors = colors.get(r.id as number) ?? []
    r.group_member_count = counts.get(r.id as number) ?? 0
  }
  return ordered
}

/**
 * 按 SigLIP 2 余弦相似度对 `vec` 排序，并在过滤器 `f` 之内。
 *
 * 走 vec0 原生的 `MATCH ... k=N` KNN 作为一个快子查询，再 JOIN `posts` 把
 * `buildWhere(f)` 当后置过滤器用，按 KNN 距离排序。
 *
 * ⚠️ **刻意不**对全表暴力算 `vec_distance_cosine`：17 万行的库上那个全扫加
 * TEMP-B-TREE 排序要跑几分钟，把其它请求全卡死（vec0 会退化成 `INDEX 0:1`
 * 全扫），而原生 KNN（`INDEX 0:3`）1–2 秒就回来。带过滤器时会超采候选，好让
 * 后置过滤器仍能凑满 `limit`；过滤器特别窄时可能不足 `limit`。没有 SigLIP 2
 * 向量的 post 永远不会出现（它们不在 KNN 表里）。
 */
export function searchByTextVector(
  sqlite: BetterSqlite3.Database,
  vec: Float32Array,
  f: PostFilter,
  { limit = 100, offset = 0 }: { limit?: number, offset?: number } = {},
): Array<Record<string, unknown>> {
  const { where, params, joins } = buildWhere(f)
  const vecBlob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
  const want = limit + offset
  // 超采，让后置过滤器有足够候选凑满 limit。
  //
  // 这里原本写成 `where.length ? Math.max(want, 1000) : want`，但那个三元恒真 ——
  // `buildWhere` 在 `onlyCanonical ?? true` 时无条件 push 一条 `canonical_post_id IS NULL`，
  // 所以 `where` 永远非空。留着那个分支等于在说一件不成立的事。
  //
  // 直接超采也没有代价：vec0 的 KNN 开销由 O(N) 的距离扫描主导（22 万条向量，1–2 秒），
  // k 从 100 抬到 1000 只多维护堆里 900 个元素，淹没在噪声里。
  const k = Math.max(want, 1000)

  const rows = sqlite
    .prepare<unknown[], Record<string, unknown>>(
      `SELECT ${SIMPLE_BASE_SELECT}, knn.distance AS _knn_distance `
      + `FROM (SELECT post_id, distance FROM ${SIGLIP2_TABLE} `
      + `      WHERE embedding MATCH ? AND k = ?) AS knn `
      + `JOIN posts p ON p.id = knn.post_id `
      + `${joins.join('\n')} `
      + `${whereSql(where)} `
      + `ORDER BY knn.distance LIMIT ? OFFSET ?`,
    )
    .all(vecBlob, k, ...params, limit, offset)

  for (const r of rows) r.dominant_color = decodeDominantColor(r.dominant_color)
  const ids = rows.map(r => r.id as number)
  const colors = fetchColorsByIds(sqlite, ids)
  const counts = memberCounts(sqlite, ids)
  for (const r of rows) {
    r.colors = colors.get(r.id as number) ?? []
    r.group_member_count = counts.get(r.id as number) ?? 0
  }
  return rows
}
