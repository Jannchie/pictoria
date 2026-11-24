/**
 * 标注队列仓储（CRUD 与取件部分）。
 *
 * **采样不在这里**：`samplePostIds` / `samplePairs` / `sampleGroups` 在 `sampling.ts`，
 * PairGraph 与并查集在 `pair-graph.ts`，它们的 SQL 在 `sampling-queries.ts`。
 */
import type BetterSqlite3 from 'better-sqlite3'
// 只取类型：annotations.ts 在运行时引用这里（advanceQueue），反过来只能是 type import。
import type { MutableKind } from './annotations.js'
import type { QueueItemPost } from './post-rows.js'
import { aliasedPostCols, MIN_PRESENTABLE_GROUP, postsById } from './post-rows.js'

/** 图片列加前缀：一行里带两张图的查询（pairwise 的 `a_` / `b_`）用。 */
export type PrefixedPost<P extends string> = { [K in keyof QueueItemPost as `${P}${K}`]: QueueItemPost[K] }

export type AbsoluteQueueItemRow = { position: number } & QueueItemPost
export type PairwiseQueueItemRow = { position: number } & PrefixedPost<'a_'> & PrefixedPost<'b_'>

const QUEUE_COLUMNS = 'id, name, kind, dimensions, scale, created_at, strategy'

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

/**
 * 队列项表 —— 代码级白名单，值会进 SQL。`annotations.ts` 的 advanceQueue 也用它。
 *
 * `Record<MutableKind, …>`：与 annotations.ts 的 `MUTABLE` 同理，种类多一个少一个都编译不过。
 */
export const ITEM_TABLES: Record<MutableKind, string> = {
  absolute: 'absolute_queue_items',
  pairwise: 'pairwise_queue_items',
  listwise: 'listwise_queue_items',
}

/**
 * 翻转一个队列项的 done 标记，返回是否真的翻了。`done=false` 是 undo 放回去用的。
 *
 * 带前置条件（`done` 必须是相反值）：改到 0 行既可能是项不存在，也可能是它本来就在
 * 目标状态 —— 调用方（advanceQueue）需要分清这两种情况。
 */
export function markQueueItemDone(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  { kind, position, done = true }: { kind: MutableKind, position: number, done?: boolean },
): boolean {
  return (
    sqlite
      .prepare(`UPDATE ${ITEM_TABLES[kind]} SET done = ? WHERE queue_id = ? AND position = ? AND done = ?`)
      .run(done ? 1 : 0, queueId, position, done ? 0 : 1).changes > 0
  )
}

/**
 * 删掉一个队列，返回它是否存在过。
 *
 * 删队列和它的**全部项**（done 与否都删 —— 项表对 annotation_queues 有外键且不级联，
 * 留着已完成的项，队列行就删不掉）。判决事件不动：事件表不引用队列，标过的就是标过的，
 * 与它出自哪个队列无关；项上的 done 只是进度条用的标记。
 */
export function deleteQueue(sqlite: BetterSqlite3.Database, queueId: number): boolean {
  return sqlite.transaction(() => {
    for (const table of Object.values(ITEM_TABLES))
      sqlite.prepare(`DELETE FROM ${table} WHERE queue_id = ?`).run(queueId)
    return sqlite.prepare('DELETE FROM annotation_queues WHERE id = ?').run(queueId).changes > 0
  })()
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

/** 一个队列的 `created_at`（SQLite 的 `YYYY-MM-DD HH:MM:SS`，UTC）；队列不存在为 null。 */
export function queueCreatedAt(sqlite: BetterSqlite3.Database, queueId: number): string | null {
  return sqlite
    .prepare<[number], string>('SELECT created_at FROM annotation_queues WHERE id = ?')
    .pluck()
    .get(queueId) ?? null
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
 * 只取 `position > after` 的项 —— `nextPresentableListwiseItems` 跳过不可排的项后
 * 从这里接着往后取。
 */
export function nextListwiseItems(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  limit = 20,
  after = -1,
): Array<{ position: number, post_ids: number[] }> {
  return sqlite
    .prepare<[number, number, number], { position: number, post_ids: string }>(
      'SELECT position, post_ids FROM listwise_queue_items '
      + 'WHERE queue_id = ? AND done = 0 AND position > ? ORDER BY position LIMIT ?',
    )
    .all(queueId, after, limit)
    .map(r => ({ position: r.position, post_ids: JSON.parse(r.post_ids) as number[] }))
}

/**
 * listwise 队列接下来的 `limit` 个**可排**的项，成员已换成图片行（呈现顺序不变）。
 *
 * 成员被删到不足 MIN_PRESENTABLE_GROUP 张的项不发出去，而是就地标完成：发出去的话，
 * 剩一张的组根本提交不了（提交要求 >= 2 张），客户端就卡在这一项上；不标完成的话，它会
 * 永远占着队列头，每次取件都重新被跳过一遍。被跳过的项不写任何事件 —— 它没被排过。
 * 删图时（`deleteManyReturningPaths`）不关 listwise 项，这里是唯一的判定处。
 *
 * 跳过之后继续往后取，直到凑满 `limit` 或队列见底，所以调用方拿到的条数与没有被删图时
 * 一致。
 */
export function nextPresentableListwiseItems(
  sqlite: BetterSqlite3.Database,
  queueId: number,
  limit: number,
): Array<{ position: number, posts: QueueItemPost[] }> {
  const retire = sqlite.prepare('UPDATE listwise_queue_items SET done = 1 WHERE queue_id = ? AND position = ? AND done = 0')
  return sqlite.transaction(() => {
    const out: Array<{ position: number, posts: QueueItemPost[] }> = []
    let after = -1
    while (out.length < limit) {
      const items = nextListwiseItems(sqlite, queueId, limit - out.length, after)
      if (!items.length)
        break
      const byId = postsById(sqlite, items.flatMap(i => i.post_ids))
      for (const item of items) {
        const posts = item.post_ids.flatMap(pid => byId.get(pid) ?? [])
        if (posts.length >= MIN_PRESENTABLE_GROUP)
          out.push({ position: item.position, posts })
        else
          retire.run(queueId, item.position)
      }
      after = items[items.length - 1]!.position
    }
    return out
  })()
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
