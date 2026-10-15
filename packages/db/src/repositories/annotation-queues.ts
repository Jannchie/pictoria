/**
 * 标注队列仓储（CRUD 与取件部分）。
 *
 * **采样不在这里**：`samplePostIds` / `samplePairs` / `sampleGroups` 在 `sampling.ts`，
 * PairGraph 与并查集在 `pair-graph.ts`，它们的 SQL 在 `sampling-queries.ts`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import type { MutableKind, QueueItemPost } from './annotations.js'
import { aliasedPostCols, ITEM_TABLES } from './annotations.js'

/** 图片列加前缀：一行里带两张图的查询（pairwise 的 `a_` / `b_`）用。 */
export type PrefixedPost<P extends string> = { [K in keyof QueueItemPost as `${P}${K}`]: QueueItemPost[K] }

export type AbsoluteQueueItemRow = { position: number } & QueueItemPost
export type PairwiseQueueItemRow = { position: number } & PrefixedPost<'a_'> & PrefixedPost<'b_'>

export const QUEUE_COLUMNS = 'id, name, kind, dimensions, scale, created_at, strategy'

export interface AnnotationQueueRow {
  id: number
  name: string
  kind: MutableKind
  /** DB 里是 JSON 数组字符串，读出来已解析。 */
  dimensions: string[]
  scale: number | null
  created_at: string
  /** pairwise 队列的采样策略；其余形态为 NULL。 */
  strategy: string | null
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
  { name, dimensions, pairs, strategy }: { name: string, dimensions: string[], pairs: Array<[number, number]>, strategy?: string | null },
): number {
  const insertItem = sqlite.prepare(
    'INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b) VALUES (?, ?, ?, ?)',
  )
  let qid = 0
  sqlite.transaction(() => {
    const { lastInsertRowid } = sqlite
      .prepare("INSERT INTO annotation_queues (name, kind, dimensions, scale, strategy) VALUES (?, 'pairwise', ?, NULL, ?)")
      .run(name, JSON.stringify(dimensions), strategy ?? null)
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
    .prepare<[], Omit<AnnotationQueueRow, 'dimensions'> & { dimensions: string }>(`SELECT ${QUEUE_COLUMNS} FROM annotation_queues ORDER BY id DESC`)
    .all()
    .map((q): AnnotationQueueRow => ({ ...q, dimensions: JSON.parse(q.dimensions) as string[] }))

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
): AbsoluteQueueItemRow[] {
  return sqlite
    .prepare<[number, number], AbsoluteQueueItemRow>(
      `SELECT i.position, ${aliasedPostCols('p', '')} `
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
): PairwiseQueueItemRow[] {
  return sqlite
    .prepare<[number, number], PairwiseQueueItemRow>(
      `SELECT i.position, ${aliasedPostCols('pa', 'a_')}, ${aliasedPostCols('pb', 'b_')} `
      + 'FROM pairwise_queue_items i '
      + 'JOIN posts pa ON pa.id = i.post_a JOIN posts pb ON pb.id = i.post_b '
      + 'WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?',
    )
    .all(queueId, limit)
}
