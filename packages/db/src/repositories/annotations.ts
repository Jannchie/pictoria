/**
 * 只追加的标注事件仓储（absolute / pairwise / content-flag）—— 形状承自已退役的 Python 侧
 * `db/repositories/annotations.py`。
 *
 * 事件从不更新：对同一个 (post, dimension) 重新标注是**追加**一行，导出时按
 * latest-wins 聚合。重复行顺带就是免费的评分者内重测数据。
 *
 * 两个操作打破了这条规则，理由相同且都是有意的：`undo` 直接 DELETE、`edit` 原地
 * UPDATE。`scripts/export_annotations.py` 对 pairwise 是一行一条判决、没有
 * latest-wins 环节，而 `AnnotationQueueRepo._judged_graph` 认为一对问过就永远问过 ——
 * 所以撤回或更正后仍留在表里的判决会留在训练集里。改成打标记而不是重写，等于把过滤
 * 义务摊派给每一个读者，漏掉一个会在训练数据里静默出错。
 */
import { placeholders } from '../sql.js'
import { SILVA } from '../scorers.js'
import { isRepeatMeasurement } from './sampling-queries.js'
import { scorerValuesFor } from './scores.js'
import type BetterSqlite3 from 'better-sqlite3'

export const ABSOLUTE_COLUMNS
  = 'id, created_at, post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms, edited_at'
export const PAIRWISE_COLUMNS
  = 'id, created_at, post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms, edited_at'
export const LISTWISE_COLUMNS
  = 'id, created_at, post_ids, ranking, dimension, rubric_version, session_id, elapsed_ms, edited_at'
export const FLAG_COLUMNS = 'id, created_at, post_id, flag, session_id'

/**
 * 评分者可以撤回或更正的事件种类，代码级白名单 —— 这些值会变成表名和列名，
 * 绝不能来自调用方输入。
 *
 * 准入规则是"有消费者按一行一事件读这条流"，这才让错误的行有代价。content flag
 * 不在此列：除了 `latestContentFlag` 没人读它，而且 `'none'` 本身就是它的撤回 ——
 * 多一个事件，而不是删掉一个。
 */
export const MUTABLE_KINDS = ['absolute', 'pairwise', 'listwise'] as const
export type MutableKind = typeof MUTABLE_KINDS[number]

// `Record<MutableKind, …>`：元组多一个或少一个，这张表都编译不过。
const MUTABLE: Record<MutableKind, { table: string, column: string }> = {
  absolute: { table: 'absolute_annotations', column: 'value' },
  pairwise: { table: 'pairwise_annotations', column: 'winner' },
  listwise: { table: 'listwise_annotations', column: 'ranking' },
}

/**
 * 三条事件流合成一条，最新在前。列形状统一好让 UNION 通过类型检查；某一类缺的列
 * 在那一支里是 NULL。
 *
 * `kind` 进排序键而不只是载荷：`created_at` 是秒级（`datetime('now')`），而评分者
 * 大约一秒一个事件，所以打平是常态而非边角情况，且 id 只在**单张表内**递增。
 * `(created_at, kind, id)` 是能全序化这条合并流的最粗三元组，游标因此可以精确而不是
 * 大致正确。
 */
const TIMELINE_SQL = `
SELECT id, created_at, 'pairwise' AS kind, post_a AS post, post_b, dimension,
       winner, NULL AS scale, NULL AS value, NULL AS flag, NULL AS ranking, edited_at
  FROM pairwise_annotations
UNION ALL
SELECT id, created_at, 'absolute', post_id, NULL, dimension,
       NULL, scale, value, NULL, NULL, edited_at
  FROM absolute_annotations
UNION ALL
SELECT id, created_at, 'listwise',
       COALESCE(json_extract(ranking, '$[0]'), json_extract(post_ids, '$[0]')), NULL, dimension,
       NULL, NULL, NULL, NULL, ranking, edited_at
  FROM listwise_annotations
UNION ALL
SELECT id, created_at, 'flag', post_id, NULL, NULL,
       NULL, NULL, NULL, flag, NULL, NULL
  FROM content_flag_events
`

export interface AbsoluteEventIn {
  postId: number
  dimension: string
  scale: number
  value: number
  rubricVersion: string
  sessionId: string
  elapsedMs?: number | null
}

export function insertAbsolute(sqlite: BetterSqlite3.Database, e: AbsoluteEventIn): number {
  const { lastInsertRowid } = sqlite
    .prepare(
      'INSERT INTO absolute_annotations (post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(e.postId, e.dimension, e.scale, e.value, e.rubricVersion, e.sessionId, e.elapsedMs ?? null)
  return Number(lastInsertRowid)
}

export interface PairwiseEventIn {
  postA: number
  postB: number
  dimension: string
  winner: string
  rubricVersion: string
  sessionId: string
  elapsedMs?: number | null
  /** 客户端**请求**的采样方式。省略 = 未知（只应出现在 0017 之前的存量行上）。 */
  strategy?: string | null
}

export function insertPairwise(sqlite: BetterSqlite3.Database, e: PairwiseEventIn): number {
  // 来源由服务端定谳：客户端只知道自己请求了哪种采样，重复测量是它无法核实的（见
  // isRepeatMeasurement）。放在仓库层而不是路由层，是为了让它绕不过去。
  const strategy = isRepeatMeasurement(sqlite, { a: e.postA, b: e.postB, dimension: e.dimension })
    ? 'repeat'
    : e.strategy ?? null
  const { lastInsertRowid } = sqlite
    .prepare(
      'INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms, strategy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(e.postA, e.postB, e.dimension, e.winner, e.rubricVersion, e.sessionId, e.elapsedMs ?? null, strategy)
  return Number(lastInsertRowid)
}

export interface ListwiseEventIn {
  postIds: number[]
  /** 最好在前；空数组 = skip。非空时必须是 postIds 的一个排列（应用层校验）。 */
  ranking: number[]
  dimension: string
  rubricVersion: string
  sessionId: string
  elapsedMs?: number | null
}

export function insertListwise(sqlite: BetterSqlite3.Database, e: ListwiseEventIn): number {
  const { lastInsertRowid } = sqlite
    .prepare(
      'INSERT INTO listwise_annotations (post_ids, ranking, dimension, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(JSON.stringify(e.postIds), JSON.stringify(e.ranking), e.dimension, e.rubricVersion, e.sessionId, e.elapsedMs ?? null)
  return Number(lastInsertRowid)
}

export function insertContentFlag(
  sqlite: BetterSqlite3.Database,
  { postId, flag, sessionId }: { postId: number, flag: string, sessionId: string },
): number {
  const { lastInsertRowid } = sqlite
    .prepare('INSERT INTO content_flag_events (post_id, flag, session_id) VALUES (?, ?, ?)')
    .run(postId, flag, sessionId)
  return Number(lastInsertRowid)
}

/**
 * 提交时顺带推进的队列项。两个字段**都**给了才算 —— 无队列的流式标注两个都不带，
 * 只带一个是客户端的半截状态，按"没有队列"处理（与改动前的路由行为一致）。
 */
export interface QueueRef {
  queueId?: number | null
  queuePosition?: number | null
}

function advanceQueue(
  sqlite: BetterSqlite3.Database,
  { queueId, queuePosition }: QueueRef,
  kind: MutableKind,
  done: boolean,
): void {
  if (queueId != null && queuePosition != null)
    markQueueItemDone(sqlite, queueId, { kind, position: queuePosition, done })
}

/*
 * record* / retract —— 写事件与推进队列放在**同一个事务**里。
 *
 * 分两步时，事件落了库、队列标记没跟上（或反过来）的窗口里进程一挂，队列就会把这一项
 * 再发一遍：同一个人对同一对第二次判决，看起来就像一次重复测量，而它其实是一次重放。
 * absolute 一批是多条 insert，中途某条撞上 CHECK 时前几条也必须一起退掉 —— 半批
 * 评分（例如四个维度只落了两个）对 latest-wins 的导出是静默的缺口。
 *
 * 队列项不存在（id/position 对不上）**不是**错误：markQueueItemDone 只是改到 0 行。
 * 这与拆分前的行为一致 —— 队列可能在标注途中被清掉，事件本身仍然有效。
 */

/** 一批 absolute 事件（同一张图的几个维度），原子地写入并推进队列。返回新行 id。 */
export function recordAbsolute(
  sqlite: BetterSqlite3.Database,
  { events, ...queue }: { events: AbsoluteEventIn[] } & QueueRef,
): number[] {
  return sqlite.transaction(() => {
    const ids = events.map(e => insertAbsolute(sqlite, e))
    advanceQueue(sqlite, queue, 'absolute', true)
    return ids
  })()
}

/** 一条 pairwise 判决，原子地写入并推进队列。返回新行 id。 */
export function recordPairwise(sqlite: BetterSqlite3.Database, e: PairwiseEventIn & QueueRef): number {
  return sqlite.transaction(() => {
    const id = insertPairwise(sqlite, e)
    advanceQueue(sqlite, e, 'pairwise', true)
    return id
  })()
}

/** 一条 listwise 排序，原子地写入并推进队列。返回新行 id。 */
export function recordListwise(sqlite: BetterSqlite3.Database, e: ListwiseEventIn & QueueRef): number {
  return sqlite.transaction(() => {
    const id = insertListwise(sqlite, e)
    advanceQueue(sqlite, e, 'listwise', true)
    return id
  })()
}

/**
 * 撤回本会话刚写的事件并把队列项放回去，原子地。返回真正删掉的行数。
 *
 * 空 `ids` 合法：被跳过的队列项不写事件就标记完成，它的 undo 就只是取消标记。
 */
export function retractAnnotations(
  sqlite: BetterSqlite3.Database,
  { kind, ids, sessionId, ...queue }: { kind: MutableKind, ids: number[], sessionId: string } & QueueRef,
): number {
  return sqlite.transaction(() => {
    const deleted = undoAnnotations(sqlite, { kind, ids, sessionId })
    advanceQueue(sqlite, queue, kind, false)
    return deleted
  })()
}

/**
 * listwise 提交的结构校验，返回错误描述或 `null`。路由的 zod schema 用它做 superRefine。
 *
 * 排序必须是这组成员的一个排列 —— 少一张、多一张、排到别的组的图，都是客户端 bug，
 * 拦在入口比拦在训练导出里便宜四个数量级。空数组 = skip，合法。
 */
export function listwiseShapeError(
  { postIds, ranking }: { postIds: number[], ranking: number[] },
): { field: 'postIds' | 'ranking', message: string } | null {
  if (new Set(postIds).size !== postIds.length)
    return { field: 'postIds', message: `postIds must be distinct, got ${JSON.stringify(postIds)}` }
  const sameMembers = ranking.length === postIds.length
    && new Set(ranking).size === ranking.length
    && ranking.every(pid => postIds.includes(pid))
  if (ranking.length && !sameMembers)
    return { field: 'ranking', message: 'ranking must be a permutation of postIds (or [] to skip)' }
  return null
}

/**
 * 删掉本会话刚写的事件，返回真正删掉几行。
 *
 * `sessionId` 是**护栏而非查找键**：调用方已经知道 id 了，要求 session 匹配意味着
 * 一个过期的客户端伸不进别人的历史。对不上的 id 就是不删，所以部分生效的撤回会
 * 如实报告它做到的条数，而不是为一条本来就不在的行抛错。
 */
export function undoAnnotations(
  sqlite: BetterSqlite3.Database,
  { kind, ids, sessionId }: { kind: MutableKind, ids: number[], sessionId: string },
): number {
  const spec = MUTABLE[kind]
  if (!ids.length)
    return 0
  return sqlite
    .prepare(`DELETE FROM ${spec.table} WHERE session_id = ? AND id IN (${placeholders(ids.length)})`)
    .run(sessionId, ...ids).changes
}

/**
 * 合并事件流的一页，最新在前。
 *
 * 用游标而不是 OFFSET，因为这个列表的头部正在被读者滚动时写入：会话里每提交一条
 * 判决就把所有 offset 推后一位，几秒后取的第 2 页会重复第 1 页已经显示过的行。
 * `before` 是客户端手里最后一行的 `(created_at, kind, id)`，行值比较从它之后严格
 * 续上，无论中间又落了什么。
 *
 * **这里不 join posts**。这条流是三张表的 UNION，而调用方每行只需要一两个 post 的
 * 图片字段；在 union 内部 join 会对 LIMIT 砍掉之前的每一个候选行都做那份工。
 */
export function annotationTimeline(
  sqlite: BetterSqlite3.Database,
  { limit, before }: { limit: number, before?: TimelineCursor | null },
): TimelineRow[] {
  const where = before ? 'WHERE (created_at, kind, id) < (?, ?, ?)' : ''
  const params = before ? [...before] : []
  return sqlite
    .prepare<unknown[], TimelineRow>(
      `SELECT * FROM (${TIMELINE_SQL}) ${where} `
      + `ORDER BY created_at DESC, kind DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit)
}

/** TIMELINE_SQL 的一行。某一类没有的列在那一支里是 NULL。 */
export interface TimelineRow {
  id: number
  created_at: string
  kind: 'pairwise' | 'absolute' | 'listwise' | 'flag'
  /** pairwise 是 post_a，listwise 是赢家（skip 时是呈现序第一张）。 */
  post: number
  post_b: number | null
  dimension: string | null
  winner: string | null
  scale: number | null
  value: number | null
  flag: string | null
  /** listwise：post_id JSON 数组，最好在前；`[]` = skip。 */
  ranking: string | null
  edited_at: string | null
}

/** 解析好的 timeline 游标：`(created_at, kind, id)`，合并流的一个排序位置。 */
export type TimelineCursor = [string, string, number]

const CURSOR_PARTS = 3
export const TIMELINE_MAX_LIMIT = 100

/**
 * `created_at|kind|id` —— 把合并流的全序压成一个不透明 token。
 *
 * 对客户端刻意不透明：它是一个**排序位置**而不是行 id，把三段都编进去，下一页才能
 * 精确地从这一页停下的地方续上（id 只在单表内递增）。
 *
 * **只为一页的最后一条原始行生成**，绝不逐条生成：post 已被删的行会从 items 里剔掉，
 * 所以最后一条可见条目不是这页停下的位置，从它续会把被剔掉的重新发一遍。
 */
export function encodeTimelineCursor(row: Pick<TimelineRow, 'created_at' | 'kind' | 'id'>): string {
  return `${row.created_at}|${row.kind}|${row.id}`
}

/** 没有游标 → `null`（第一页）；格式不对 → `'malformed'`，由调用方回 400。 */
export function parseTimelineCursor(raw?: string | null): TimelineCursor | 'malformed' | null {
  if (!raw)
    return null
  const parts = raw.split('|')
  if (parts.length !== CURSOR_PARTS || parts.some(p => !p) || !/^\d+$/.test(parts[2]!))
    return 'malformed'
  return [parts[0]!, parts[1]!, Number(parts[2])]
}

export interface TimelineEntry extends TimelineRow {
  postRow: QueueItemPost
  postBRow: QueueItemPost | null
}

/**
 * timeline 的一页：行 + 已经取好的图片行 + 下一页游标。
 *
 * `limit` 夹到 `[1, TIMELINE_MAX_LIMIT]`。判决之后 post 被删了的事件没东西可展示，在
 * 这里剔掉比渲染一个碎块诚实 —— 但游标仍然取**原始**最后一行（见 encodeTimelineCursor），
 * 是否还有下一页也按原始行数判断。
 */
export function timelinePage(
  sqlite: BetterSqlite3.Database,
  { limit, before }: { limit: number, before?: TimelineCursor | null },
): { entries: TimelineEntry[], nextCursor: string | null } {
  const page = Math.min(Math.max(limit, 1), TIMELINE_MAX_LIMIT)
  const rows = annotationTimeline(sqlite, { limit: page, before })
  const posts = postsById(sqlite, rows.flatMap(r => (r.post_b ? [r.post, r.post_b] : [r.post])))
  const entries: TimelineEntry[] = []
  for (const r of rows) {
    const postRow = posts.get(r.post)
    const postBRow = r.post_b ? posts.get(r.post_b) : null
    if (!postRow || postBRow === undefined)
      continue
    entries.push({ ...r, postRow, postBRow })
  }
  return {
    entries,
    nextCursor: rows.length === page ? encodeTimelineCursor(rows[rows.length - 1]!) : null,
  }
}

/**
 * 原地更正一条事件的判决，返回是否有行被改。
 *
 * 原地而非追加：见 migration 0014 —— pairwise 导出是一行一条判决、没有 latest-wins
 * 环节，追加一条更正只会让**错的那条**留在训练集里。`edited_at` 是标记
 * `elapsed_ms` 不再描述这一行的东西。
 */
export function editAnnotation(
  sqlite: BetterSqlite3.Database,
  { kind, annotationId, verdict }: { kind: MutableKind, annotationId: number, verdict: number | string },
): boolean {
  const spec = MUTABLE[kind]
  return (
    sqlite
      .prepare(`UPDATE ${spec.table} SET ${spec.column} = ?, edited_at = datetime('now') WHERE id = ?`)
      .run(verdict, annotationId).changes > 0
  )
}

/** `absolute_annotations` 的一行（ABSOLUTE_COLUMNS）。 */
export interface AbsoluteAnnotationRow {
  id: number
  created_at: string
  post_id: number
  dimension: string
  scale: number
  value: number
  rubric_version: string
  session_id: string
  elapsed_ms: number | null
  edited_at: string | null
}

/** `pairwise_annotations` 的一行（PAIRWISE_COLUMNS）。 */
export interface PairwiseAnnotationRow {
  id: number
  created_at: string
  post_a: number
  post_b: number
  dimension: string
  winner: string
  rubric_version: string
  session_id: string
  elapsed_ms: number | null
  edited_at: string | null
}

/** `listwise_annotations` 的一行（LISTWISE_COLUMNS）；两个数组列仍是 JSON 串。 */
export interface ListwiseAnnotationRow {
  id: number
  created_at: string
  post_ids: string
  ranking: string
  dimension: string
  rubric_version: string
  session_id: string
  elapsed_ms: number | null
  edited_at: string | null
}

/** `content_flag_events` 的一行（FLAG_COLUMNS）。 */
export interface ContentFlagRow {
  id: number
  created_at: string
  post_id: number
  flag: string
  session_id: string
}

export function listAbsoluteForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
): AbsoluteAnnotationRow[] {
  return sqlite
    .prepare<[number], AbsoluteAnnotationRow>(
      `SELECT ${ABSOLUTE_COLUMNS} FROM absolute_annotations WHERE post_id = ? ORDER BY id`,
    )
    .all(postId)
}

export function listPairwiseForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
): PairwiseAnnotationRow[] {
  return sqlite
    .prepare<[number, number], PairwiseAnnotationRow>(
      `SELECT ${PAIRWISE_COLUMNS} FROM pairwise_annotations WHERE post_a = ? OR post_b = ? ORDER BY id`,
    )
    .all(postId, postId)
}

/**
 * 含有某张图的 listwise 事件。JSON 数组列上没有等值索引可用，`LIKE` 先粗筛（把扫描
 * 面从全表压到含这个数字串的行），再在 JS 里精确核对成员身份 —— post_id 12 不能命中
 * [112, 5]。这个查询只喂单图详情页，行数是"这张图被排过几次"，个位数。
 */
export function listListwiseForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
): ListwiseAnnotationRow[] {
  return sqlite
    .prepare<[string], ListwiseAnnotationRow>(
      `SELECT ${LISTWISE_COLUMNS} FROM listwise_annotations WHERE post_ids LIKE ? ORDER BY id`,
    )
    .all(`%${postId}%`)
    .filter(r => (JSON.parse(r.post_ids) as number[]).includes(postId))
}

export function latestContentFlag(
  sqlite: BetterSqlite3.Database,
  postId: number,
): ContentFlagRow | undefined {
  return sqlite
    .prepare<[number], ContentFlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM content_flag_events WHERE post_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(postId)
}

/**
 * 某个维度的累计 pairwise 判决数。
 *
 * `total` 是决定性判决（a/b）+ 平局 —— 也就是带信号的那些；skip 是"池子空了/采样
 * 反应"，不是标签，所以单独报告且**不计入 total**。
 */
export function countPairwise(
  sqlite: BetterSqlite3.Database,
  dimension: string,
): { total: number, decisive: number, tie: number, skip: number } {
  const rows = sqlite
    .prepare<[string], { winner: string, n: number }>(
      'SELECT winner, COUNT(*) AS n FROM pairwise_annotations WHERE dimension = ? GROUP BY winner',
    )
    .all(dimension)
  const by = new Map(rows.map(r => [r.winner, Number(r.n)]))
  const decisive = (by.get('a') ?? 0) + (by.get('b') ?? 0)
  const tie = by.get('tie') ?? 0
  return { total: decisive + tie, decisive, tie, skip: by.get('skip') ?? 0 }
}

/** 队列项表 —— 与 `_ITEM_TABLES` 对应，同样是代码级白名单（值会进 SQL）。 */
const ITEM_TABLES: Record<string, string> = {
  absolute: 'absolute_queue_items',
  pairwise: 'pairwise_queue_items',
  listwise: 'listwise_queue_items',
}

/** 翻转一个队列项的 done 标记。`done=false` 是 undo 放回去用的。 */
export function markQueueItemDone(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  { kind, position, done = true }: { kind: string, position: number, done?: boolean },
): boolean {
  const table = ITEM_TABLES[kind]
  if (!table)
    throw new Error(`unknown queue kind: ${kind}`)
  return (
    sqlite
      .prepare(`UPDATE ${table} SET done = ? WHERE queue_id = ? AND position = ?`)
      .run(done ? 1 : 0, queueId, position).changes > 0
  )
}

/** timeline / 采样都要的那七个图片列。 */
const POST_COLS = ['id', 'file_path', 'file_name', 'extension', 'sha256', 'width', 'height'] as const

export interface QueueItemPost {
  post_id: number
  file_path: string
  file_name: string
  extension: string
  sha256: string
  width: number
  height: number
}

/**
 * `post_id -> 图片行`，只含仍然存在的 id，重复自动收敛。
 *
 * 每个调用方都是"手里有一批 id 要渲染"（采样批、历史页），都需要同样这七列和同样的
 * "post 可能已经被删了"处理，所以查询只写一处。
 */
export function postsById(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, QueueItemPost> {
  const unique = [...new Set(ids)]
  const out = new Map<number, QueueItemPost>()
  if (!unique.length)
    return out
  const cols = ['p.id AS post_id', ...POST_COLS.slice(1).map(c => `p.${c} AS ${c}`)].join(', ')
  for (const row of sqlite
    .prepare<unknown[], QueueItemPost>(
      `SELECT ${cols} FROM posts p WHERE p.id IN (${placeholders(unique.length)})`,
    )
    .all(...unique))
    out.set(row.post_id, row)
  return out
}

/**
 * 按 `ids` 的顺序取图片行，已删除的静默跳过。
 *
 * 顺序是吃重的：采样顺序就是呈现顺序，所以从 `ids` 重建，而不是从 `IN (...)` 返回的行序。
 */
export function postsInOrder(sqlite: BetterSqlite3.Database, ids: number[]): QueueItemPost[] {
  const byId = postsById(sqlite, ids)
  return ids.flatMap(pid => byId.get(pid) ?? [])
}

/**
 * 一批对的图片行，整批一次取图再在 JS 里拼对。任一端被删了（采样和取图之间）的对丢掉。
 *
 * 对的**顺序**是吃重的（interleaveWithBridges 保证每个前缀都连通），所以从 `pairs` 重建。
 */
export function pairsWithPosts(
  sqlite: BetterSqlite3.Database,
  pairs: Array<[number, number]>,
): Array<[QueueItemPost, QueueItemPost]> {
  const byId = postsById(sqlite, pairs.flat())
  const out: Array<[QueueItemPost, QueueItemPost]> = []
  for (const [a, b] of pairs) {
    const rowA = byId.get(a)
    const rowB = byId.get(b)
    if (rowA && rowB)
      out.push([rowA, rowB])
  }
  return out
}

/** 一组少于这么多张就不值得排了（成员被删后剩下的）。 */
const MIN_PRESENTABLE_GROUP = 3

/**
 * 一批 listwise 组的图片行与同序的 silva 分。被删的成员静默消失，剩不到
 * MIN_PRESENTABLE_GROUP 张的组整组丢掉。
 *
 * 缺分为 `null` 而不是 `0`：`0` 会被下游当成「最差」而不是「不知道」。
 */
export function groupsWithSilva(
  sqlite: BetterSqlite3.Database,
  groups: number[][],
): Array<{ posts: QueueItemPost[], silva: Array<number | null> }> {
  const flat = groups.flat()
  const byId = postsById(sqlite, flat)
  const silvaById = scorerValuesFor(sqlite, flat, SILVA.name)
  return groups
    .map((g) => {
      const ids = g.filter(pid => byId.has(pid))
      return { posts: ids.map(pid => byId.get(pid)!), silva: ids.map(pid => silvaById.get(pid) ?? null) }
    })
    .filter(g => g.posts.length >= MIN_PRESENTABLE_GROUP)
}
