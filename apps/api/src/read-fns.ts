/**
 * 读线程池能调的函数：**唯一**的登记处。
 *
 * `inProcessReads`、`createReadPool` 返回的方法对象、读线程的分派表都从这一张表生成，
 * 加一个函数只改这里。它同时是白名单：读线程只认这里的自有键（`read-worker.ts`），
 * 所以池子不是一个任意执行器。登记的必须是只读查询 —— 线程的连接是
 * `SQLITE_OPEN_READONLY`，会写的函数在那边会当场报错。
 *
 * 参数和返回值要过结构化克隆（`postMessage`）：只能是普通数据，不能带函数。
 * 打分器的 `ScorerSpec` 带方法，所以分档计数登记的是按名字查 spec 的包装。
 */
import type { PostFilter, SqliteHandle } from '@pictoria/db'
import {
  aggregateStats,
  countByColumn,
  countByScorerBucket,
  countByTag,
  countPosts,
  FILTERABLE_SCORERS,
  knn,
  searchByTextVector,
  unratedArtistPickIds,
} from '@pictoria/db'

/** 有分档 facet 的打分器 = 能筛的打分器（waifu 走独立表，其余在 `SCORERS`）。 */
type BucketScorerName = typeof FILTERABLE_SCORERS[number]['name']

/** `countByScorerBucket`，打分器按名字传（spec 本身带方法，过不了结构化克隆）。 */
function countByScorerBucketNamed(db: SqliteHandle, f: PostFilter, scorer: BucketScorerName) {
  const spec = FILTERABLE_SCORERS.find(s => s.name === scorer)
  if (!spec)
    throw new Error(`unknown scorer: ${scorer}`)
  return countByScorerBucket(db, f, spec)
}

/**
 * 除了整库 KNN（`knn` / `searchByTextVector`，1.5–3 s），这里还有 facet 计数与聚合：
 * 带过滤的 `countByTag` 要对过滤集的全部标签行 GROUP BY（真库 5–30 s），
 * `countByColumn` / `countByScorerBucket` / `aggregateStats` 扫整个过滤集（50–300 ms），
 * `unratedArtistPickIds` 约 0.2–1.3 s。放在主线程上，它们每一次都让所有请求一起排队。
 */
export const READ_FNS = {
  knn,
  searchByTextVector,
  countPosts,
  countByColumn,
  countByScorerBucket: countByScorerBucketNamed,
  countByTag,
  aggregateStats,
  unratedArtistPickIds,
} satisfies Record<string, (db: SqliteHandle, ...args: any[]) => unknown>

export type ReadFnName = keyof typeof READ_FNS

/** 去掉第一个参数（连接）之后的参数表。可选参数保持可选。 */
export type ReadArgs<K extends ReadFnName> = Parameters<typeof READ_FNS[K]> extends [unknown, ...infer R] ? R : never

export type ReadResult<K extends ReadFnName> = ReturnType<typeof READ_FNS[K]>

export const READ_FN_NAMES = Object.keys(READ_FNS) as ReadFnName[]
