/**
 * Backfill 的**数据**一侧：待办查询与结果落库。
 *
 * 计算不在这里，也不会在这里 —— 它在 Python worker 里，通过 cairnq 往返
 * （见 `docs/refactor-monorepo-hono.md` §D1）。这个文件是那条原则里"所有数据库
 * 写入在 TS"的那一半：待办查询挑出要算什么，结果函数把算完的东西写回去。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE } from '../scorers.js'
import { SIGLIP2_TABLE } from './vectors.js'

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/** 一个 worker 的失败黑名单键，例如 `aesthetic:silva`。与 Python 侧同拼法。 */
export function aestheticWorkerKey(scorer: string): string {
  return `aesthetic:${scorer}`
}

/**
 * 排除某个 worker 桶下被拉黑的 post。带一个 `?`，调用方追加 worker 键。
 *
 * 迁移期间这张表还在：Python 侧的 backfill 仍在写它，两边的待办查询必须看到
 * 同一批候选，否则一个跳过的东西另一个会一直重算。cairnq 的重试语义最终会
 * 取代它（§D2），但那要等 Phase 6 把最后一个 worker 搬完。
 */
export function notFailedClause(alias = 'p'): string {
  return `NOT EXISTS (SELECT 1 FROM post_process_failures f WHERE f.post_id = ${alias}.id AND f.worker = ?)`
}

/**
 * 有 SigLIP2 向量、但还没有 `scorer` 分数的 post id，按 id 升序。
 *
 * "有没有向量"用一次 vec0 的 post_id 列全扫做集合求交，而不是每行一个
 * `EXISTS` —— vec0 的点查是虚表探测不是 B-tree 探测，逐行探在库规模上要几十秒。
 * 候选顺序（p.id 升序）在过滤后保持不变。
 */
export function listSilvaPending(
  sqlite: BetterSqlite3.Database,
  scorer: string,
  limit?: number,
): number[] {
  const candidates = sqlite
    .prepare<[string, string], { id: number }>(
      `SELECT p.id FROM posts p `
      + `WHERE NOT EXISTS (SELECT 1 FROM ${AESTHETIC_SCORES_TABLE} pas WHERE pas.post_id = p.id AND pas.scorer = ?) `
      + `AND ${notFailedClause('p')} `
      + `ORDER BY p.id`,
    )
    .all(scorer, aestheticWorkerKey(scorer))
    .map(r => r.id)

  const embedded = new Set(
    sqlite.prepare<[], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE}`).all().map(r => r.post_id),
  )
  const pending = candidates.filter(pid => embedded.has(pid))
  return limit === undefined ? pending : pending.slice(0, limit)
}

/**
 * `post_id -> embedding blob`，原样取出不做数值转换。
 *
 * 交给 cairnq payload 的就是这段字节的 base64（见 `@pictoria/contracts` 的
 * codec）—— 从库里读出来到 worker 手上，中间没有任何一步把它变成十进制。
 */
export function fetchEmbeddingBlobs(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  if (!ids.length)
    return out
  for (const row of sqlite
    .prepare<unknown[], { post_id: number, embedding: Buffer }>(
      `SELECT post_id, embedding FROM ${SIGLIP2_TABLE} WHERE post_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids))
    out.set(row.post_id, row.embedding)
  return out
}

/**
 * 批量写入某个 scorer 的分数。一个事务里的多条 upsert。
 *
 * 这是 worker 算完之后唯一的落库点。Python 侧一行都不写 —— 它甚至不持有到这个
 * 库的连接。
 */
export function upsertAestheticScores(
  sqlite: BetterSqlite3.Database,
  scorer: string,
  rows: Array<{ postId: number, score: number }>,
): void {
  if (!rows.length)
    return
  const stmt = sqlite.prepare(
    `INSERT INTO ${AESTHETIC_SCORES_TABLE}(post_id, scorer, score) VALUES (?, ?, ?) `
    + `ON CONFLICT (post_id, scorer) DO UPDATE SET score = excluded.score`,
  )
  sqlite.transaction(() => {
    for (const r of rows) stmt.run(r.postId, scorer, r.score)
  })()
}
