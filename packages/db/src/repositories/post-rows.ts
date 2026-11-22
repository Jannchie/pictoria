/**
 * 「手里有一批 post id 要渲染」的图片行：timeline、采样批、队列取件共用同一份七列
 * 查询和同样的「post 可能已经被删了」处理。
 *
 * 从 `annotations.ts` 拆出来，好让事件模块和队列模块都能用它而不互相引用。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { SILVA } from '../scorers.js'
import { placeholders } from '../sql.js'
import { scorerValuesFor } from './scores.js'

/** timeline / 采样 / 队列取件共用的七个图片列。 */
const POST_COLS = ['id', 'file_path', 'file_name', 'extension', 'sha256', 'width', 'height'] as const

/** `pa.id AS a_post_id, pa.file_path AS a_file_path, …` —— 一行 `QueueItemPost`（可带前缀）。 */
export function aliasedPostCols(tableAlias: string, outPrefix: string): string {
  return [
    `${tableAlias}.id AS ${outPrefix}post_id`,
    ...POST_COLS.slice(1).map(c => `${tableAlias}.${c} AS ${outPrefix}${c}`),
  ].join(', ')
}

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
  for (const row of sqlite
    .prepare<unknown[], QueueItemPost>(
      `SELECT ${aliasedPostCols('p', '')} FROM posts p WHERE p.id IN (${placeholders(unique.length)})`,
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
export const MIN_PRESENTABLE_GROUP = 3

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
