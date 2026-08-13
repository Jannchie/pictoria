/**
 * 只追加的标注事件仓储（absolute / pairwise / content-flag）—— 对应 Python 侧
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
import type BetterSqlite3 from 'better-sqlite3'

export const ABSOLUTE_COLUMNS
  = 'id, created_at, post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms, edited_at'
export const PAIRWISE_COLUMNS
  = 'id, created_at, post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms, edited_at'
export const FLAG_COLUMNS = 'id, created_at, post_id, flag, session_id'

/**
 * 评分者可以撤回或更正的事件种类，代码级白名单 —— 这些值会变成表名和列名，
 * 绝不能来自调用方输入。
 *
 * 准入规则是"有消费者按一行一事件读这条流"，这才让错误的行有代价。content flag
 * 不在此列：除了 `latestContentFlag` 没人读它，而且 `'none'` 本身就是它的撤回 ——
 * 多一个事件，而不是删掉一个。
 */
const MUTABLE: Record<string, { table: string, column: string }> = {
  absolute: { table: 'absolute_annotations', column: 'value' },
  pairwise: { table: 'pairwise_annotations', column: 'winner' },
}

export const MUTABLE_KINDS = new Set(Object.keys(MUTABLE))

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
       winner, NULL AS scale, NULL AS value, NULL AS flag, edited_at
  FROM pairwise_annotations
UNION ALL
SELECT id, created_at, 'absolute', post_id, NULL, dimension,
       NULL, scale, value, NULL, edited_at
  FROM absolute_annotations
UNION ALL
SELECT id, created_at, 'flag', post_id, NULL, NULL,
       NULL, NULL, NULL, flag, NULL
  FROM content_flag_events
`

export interface AbsoluteEventIn {
  post_id: number
  dimension: string
  scale: number
  value: number
  rubric_version: string
  session_id: string
  elapsed_ms?: number | null
}

export function insertAbsolute(sqlite: BetterSqlite3.Database, e: AbsoluteEventIn): number {
  const { lastInsertRowid } = sqlite
    .prepare(
      'INSERT INTO absolute_annotations (post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(e.post_id, e.dimension, e.scale, e.value, e.rubric_version, e.session_id, e.elapsed_ms ?? null)
  return Number(lastInsertRowid)
}

export interface PairwiseEventIn {
  post_a: number
  post_b: number
  dimension: string
  winner: string
  rubric_version: string
  session_id: string
  elapsed_ms?: number | null
}

export function insertPairwise(sqlite: BetterSqlite3.Database, e: PairwiseEventIn): number {
  const { lastInsertRowid } = sqlite
    .prepare(
      'INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(e.post_a, e.post_b, e.dimension, e.winner, e.rubric_version, e.session_id, e.elapsed_ms ?? null)
  return Number(lastInsertRowid)
}

export function insertContentFlag(
  sqlite: BetterSqlite3.Database,
  { post_id, flag, session_id }: { post_id: number, flag: string, session_id: string },
): number {
  const { lastInsertRowid } = sqlite
    .prepare('INSERT INTO content_flag_events (post_id, flag, session_id) VALUES (?, ?, ?)')
    .run(post_id, flag, session_id)
  return Number(lastInsertRowid)
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
  { kind, ids, sessionId }: { kind: string, ids: number[], sessionId: string },
): number {
  const spec = MUTABLE[kind]
  if (!spec)
    throw new Error(`not a retractable kind: ${kind}`)
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
  { limit, before }: { limit: number, before?: [string, string, number] | null },
): Array<Record<string, unknown>> {
  const where = before ? 'WHERE (created_at, kind, id) < (?, ?, ?)' : ''
  const params = before ? [...before] : []
  return sqlite
    .prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM (${TIMELINE_SQL}) ${where} `
      + `ORDER BY created_at DESC, kind DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit)
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
  { kind, annotationId, verdict }: { kind: string, annotationId: number, verdict: number | string },
): boolean {
  const spec = MUTABLE[kind]
  if (!spec)
    throw new Error(`not an editable kind: ${kind}`)
  return (
    sqlite
      .prepare(`UPDATE ${spec.table} SET ${spec.column} = ?, edited_at = datetime('now') WHERE id = ?`)
      .run(verdict, annotationId).changes > 0
  )
}

export function listAbsoluteForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
): Array<Record<string, unknown>> {
  return sqlite
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${ABSOLUTE_COLUMNS} FROM absolute_annotations WHERE post_id = ? ORDER BY id`,
    )
    .all(postId)
}

export function listPairwiseForPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
): Array<Record<string, unknown>> {
  return sqlite
    .prepare<[number, number], Record<string, unknown>>(
      `SELECT ${PAIRWISE_COLUMNS} FROM pairwise_annotations WHERE post_a = ? OR post_b = ? ORDER BY id`,
    )
    .all(postId, postId)
}

export function latestContentFlag(
  sqlite: BetterSqlite3.Database,
  postId: number,
): Record<string, unknown> | undefined {
  return sqlite
    .prepare<[number], Record<string, unknown>>(
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
