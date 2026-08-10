/**
 * 列表与搜索 —— 对应 Python 侧 `PostQueryService.list_paginated` / `search`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { buildWhere, ORDERABLE_COLUMNS, type PostFilter } from '../filters.js'
import { SILVA, SILVA_LUNA } from '../scorers.js'
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
const VIRTUAL_SORT_COLUMNS = new Set(['waifu_score', 'silva_score', 'silva_luna_score', 'discrepancy'])

export interface PostFilterWithOrder extends PostFilter {
  order_by?: string | null
  order?: 'asc' | 'desc' | 'random' | null
  order_seed?: number | null
  sort_direction?: 'asc' | 'desc' | null
}

function whereSql(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
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
  if (orderBy === 'waifu_score') {
    if (!joins.some(j => j.includes('post_waifu_scores')))
      extra.push('LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id')
    return { extra, selectExpr: 'pws.score', orderExpr: 'pws.score' }
  }
  if (orderBy === 'silva_luna_score') {
    if (!SILVA_LUNA.isJoined(joins))
      extra.push(SILVA_LUNA.joinSql())
    return { extra, selectExpr: SILVA_LUNA.scoreCol(), orderExpr: SILVA_LUNA.scoreCol() }
  }
  // silva_score 和 discrepancy 都挂在 SILVA 那个 join 上
  if (!SILVA.isJoined(joins))
    extra.push(SILVA.joinSql())
  if (orderBy === 'silva_score')
    return { extra, selectExpr: SILVA.scoreCol(), orderExpr: SILVA.scoreCol() }

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
): { sql: string, params: unknown[] } {
  const { where, params, joins } = buildWhere(f)
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
  const orderParams: unknown[] = []
  let resortSql = ''
  const sortable = Boolean(f.order_by) && ORDERABLE_COLUMNS.has(f.order_by!)

  if (f.order === 'random') {
    const seed = ((f.order_seed || 1) % 2147483647) || 1
    orderSql = 'ORDER BY ((p.id * ?) % 2147483647)'
    orderParams.push(seed)
    if (sortable) {
      // 种子哈希决定主序；请求的列变成对 `_sort_col` 的外层重排。
      let selectExpr: string
      if (VIRTUAL_SORT_COLUMNS.has(f.order_by!)) {
        const v = resolveVirtualSort(f.order_by!, joins)
        extraJoins.push(...v.extra)
        selectExpr = v.selectExpr
      }
      else {
        selectExpr = `p.${f.order_by}`
      }
      selectCols += `, ${selectExpr} AS _sort_col`
      const resortDir = f.sort_direction === 'asc' ? 'ASC' : 'DESC'
      resortSql = `ORDER BY _sort_col ${resortDir} NULLS LAST`
    }
  }
  else if (sortable) {
    const direction = f.order === 'asc' ? 'ASC' : 'DESC'
    // 唯一的次序键，让 offset 分页稳定：排序列上打平的行（score/rating 大量重复、
    // NULL 成片）否则顺序是任意的，翻页之间会变。
    const tiebreak = f.order_by === 'id' ? '' : `, p.id ${direction}`
    if (VIRTUAL_SORT_COLUMNS.has(f.order_by!)) {
      const v = resolveVirtualSort(f.order_by!, joins)
      extraJoins.push(...v.extra)
      selectCols += `, ${v.selectExpr} AS _sort_col`
      orderSql = `ORDER BY ${v.orderExpr} ${direction} NULLS LAST${tiebreak}`
    }
    else {
      if (f.order_by !== 'id')
        selectCols += `, p.${f.order_by} AS _sort_col`
      orderSql = `ORDER BY p.${f.order_by} ${direction}${tiebreak}`
    }
  }

  const allJoins = [...joins, ...extraJoins]
  const fromClause = `FROM posts p${allJoins.length ? `\n${allJoins.join('\n')}` : ''}`
  const sql = resortSql
    ? `SELECT * FROM (${selectCols} ${fromClause} ${wSql} ${orderSql} LIMIT ? OFFSET ?) ${resortSql}`
    : `${selectCols} ${fromClause} ${wSql} ${orderSql} LIMIT ? OFFSET ?`

  return { sql, params: [...params, ...orderParams, limit, offset] }
}

/** 搜索，返回可直接喂给 `PostSimplePublic` 的行。 */
export function searchPosts(
  sqlite: BetterSqlite3.Database,
  f: PostFilterWithOrder,
  { limit = 100, offset = 0 }: { limit?: number, offset?: number } = {},
): Array<Record<string, unknown>> {
  const { sql, params } = buildSearchQuery(f, limit, offset)
  const rows = sqlite.prepare<unknown[], Record<string, unknown>>(sql).all(...params)

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
