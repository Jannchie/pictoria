/**
 * 标注队列仓储（CRUD 与取件部分）—— 形状承自已退役的 Python 侧
 * `db/repositories/annotation_queues.py` 里不涉及采样的那一半。
 *
 * **采样不在这里**：`sample_post_ids` / `sample_pairs` 及其 `_PairGraph`、并查集、
 * 多样性子集、重访池等约 700 行算法仍在 Python 侧，对应的四个端点还走代理。
 */
import type BetterSqlite3 from 'better-sqlite3'

export const QUEUE_COLUMNS = 'id, name, kind, dimensions, scale, created_at'

/** 队列项表 —— 代码级白名单，值会进 SQL。 */
const ITEM_TABLES: Record<string, string> = {
  absolute: 'absolute_queue_items',
  pairwise: 'pairwise_queue_items',
  listwise: 'listwise_queue_items',
}

/** timeline / 队列取件共用的七个图片列。 */
const POST_COLS = ['id', 'file_path', 'file_name', 'extension', 'sha256', 'width', 'height'] as const

/** `pa.id AS a_post_id, pa.file_path AS a_file_path, …` */
function aliasedPostCols(tableAlias: string, outPrefix: string): string {
  return [
    `${tableAlias}.id AS ${outPrefix}post_id`,
    ...POST_COLS.slice(1).map(c => `${tableAlias}.${c} AS ${outPrefix}${c}`),
  ].join(', ')
}

export interface AnnotationQueueRow {
  id: number
  name: string
  kind: 'absolute' | 'pairwise' | 'listwise'
  /** JSON 数组字符串。 */
  dimensions: string
  scale: number | null
  created_at: string
}

export function createAbsoluteQueue(
  sqlite: BetterSqlite3.Database,
  { name, dimensions, scale, postIds }: { name: string, dimensions: string[], scale: number, postIds: number[] },
): number {
  const insertItem = sqlite.prepare(
    'INSERT INTO absolute_queue_items (queue_id, position, post_id) VALUES (?, ?, ?)',
  )
  let qid = 0
  sqlite.transaction(() => {
    const { lastInsertRowid } = sqlite
      .prepare("INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'absolute', ?, ?)")
      .run(name, JSON.stringify(dimensions), scale)
    qid = Number(lastInsertRowid)
    postIds.forEach((pid, pos) => insertItem.run(qid, pos, pid))
  })()
  return qid
}

export function createPairwiseQueue(
  sqlite: BetterSqlite3.Database,
  { name, dimensions, pairs }: { name: string, dimensions: string[], pairs: Array<[number, number]> },
): number {
  const insertItem = sqlite.prepare(
    'INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b) VALUES (?, ?, ?, ?)',
  )
  let qid = 0
  sqlite.transaction(() => {
    const { lastInsertRowid } = sqlite
      .prepare("INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'pairwise', ?, NULL)")
      .run(name, JSON.stringify(dimensions))
    qid = Number(lastInsertRowid)
    pairs.forEach(([a, b], pos) => insertItem.run(qid, pos, a, b))
  })()
  return qid
}

export function createListwiseQueue(
  sqlite: BetterSqlite3.Database,
  { name, dimensions, groups }: { name: string, dimensions: string[], groups: number[][] },
): number {
  const insertItem = sqlite.prepare(
    'INSERT INTO listwise_queue_items (queue_id, position, post_ids) VALUES (?, ?, ?)',
  )
  let qid = 0
  sqlite.transaction(() => {
    const { lastInsertRowid } = sqlite
      .prepare("INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'listwise', ?, NULL)")
      .run(name, JSON.stringify(dimensions))
    qid = Number(lastInsertRowid)
    groups.forEach((ids, pos) => insertItem.run(qid, pos, JSON.stringify(ids)))
  })()
  return qid
}

export interface QueueWithProgress {
  queue: AnnotationQueueRow
  total: number
  done: number
}

/**
 * 每个队列的 `(queue, total, done)`，最新在前。
 *
 * 两条分组计数（每张项表一条），而不是每个队列一条查询。队列列表现在还短，但它在
 * 标注落地页上，且每生成一个队列就长一条。
 */
export function listQueues(sqlite: BetterSqlite3.Database): QueueWithProgress[] {
  const queues = sqlite
    .prepare<[], AnnotationQueueRow>(`SELECT ${QUEUE_COLUMNS} FROM annotation_queues ORDER BY id DESC`)
    .all()

  const progress = new Map<string, { total: number, done: number }>()
  for (const [kind, table] of Object.entries(ITEM_TABLES)) {
    for (const r of sqlite
      .prepare<[], { queue_id: number, total: number, done: number }>(
        `SELECT queue_id, COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM ${table} GROUP BY queue_id`,
      )
      .all())
      progress.set(`${kind}:${r.queue_id}`, { total: Number(r.total), done: Number(r.done) })
  }

  return queues.map(q => ({
    queue: q,
    ...(progress.get(`${q.kind}:${q.id}`) ?? { total: 0, done: 0 }),
  }))
}

export function nextAbsoluteItems(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  limit = 20,
): Array<Record<string, unknown>> {
  return sqlite
    .prepare<[number, number], Record<string, unknown>>(
      'SELECT i.position, p.id AS post_id, p.file_path, p.file_name, p.extension, p.sha256, p.width, p.height '
      + 'FROM absolute_queue_items i JOIN posts p ON p.id = i.post_id '
      + 'WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?',
    )
    .all(queueId, limit)
}

/**
 * 未完成的 listwise 队列项，`post_ids` 已解析成数组。
 *
 * 不在这里 join posts：一项有 ~8 个成员，成员的图片行由调用方拿着扁平 id 列表经
 * `postsById` 一次取齐（与 timeline 同一份查询），而不是在 SQL 里对 JSON 展开。
 */
export function nextListwiseItems(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  limit = 20,
): Array<{ position: number, post_ids: number[] }> {
  return sqlite
    .prepare<[number, number], { position: number, post_ids: string }>(
      'SELECT position, post_ids FROM listwise_queue_items WHERE queue_id = ? AND done = 0 ORDER BY position LIMIT ?',
    )
    .all(queueId, limit)
    .map(r => ({ position: r.position, post_ids: JSON.parse(r.post_ids) as number[] }))
}

export function nextPairwiseItems(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  limit = 20,
): Array<Record<string, unknown>> {
  return sqlite
    .prepare<[number, number], Record<string, unknown>>(
      `SELECT i.position, ${aliasedPostCols('pa', 'a_')}, ${aliasedPostCols('pb', 'b_')} `
      + 'FROM pairwise_queue_items i '
      + 'JOIN posts pa ON pa.id = i.post_a JOIN posts pb ON pb.id = i.post_b '
      + 'WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?',
    )
    .all(queueId, limit)
}
