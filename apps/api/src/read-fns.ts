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
  countAllTags,
  countByColumn,
  countByScorerBucket,
  countByTagFast,
  countPosts,
  FILTERABLE_SCORERS,
  folderScoreAggregates,
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
 * 当前这次读的取消检查。读线程（`read-worker.ts`）在每次调用前用 `withAbortCheck` 换上
 * “主线程是不是已经放弃了这个请求”的判断；分块执行的读（`countAllTags`）在块之间问它。
 * 线程是单线程同步执行的，一个模块级变量就够，不会串到别的请求上。
 */
let currentAbortCheck: () => boolean = () => false

export function withAbortCheck<T>(check: () => boolean, run: () => T): T {
  const prev = currentAbortCheck
  currentAbortCheck = check
  try {
    return run()
  }
  finally {
    currentAbortCheck = prev
  }
}

/** 带过滤的 tag facet 全量（`read-cache.ts` 按过滤签名缓存它）：可取消。 */
function countAllTagsCancellable(db: SqliteHandle, f: PostFilter) {
  return countAllTags(db, f, { shouldAbort: currentAbortCheck })
}

/**
 * 除了整库 KNN（`knn` / `searchByTextVector`，1.5–3 s），这里还有 facet 计数与聚合：
 * 带过滤的 tag facet（`countAllTags`）要对过滤集的全部标签行 GROUP BY（真库 0.3–8 s），
 * `countByColumn` / `countByScorerBucket` / `aggregateStats` 扫整个过滤集（50–300 ms），
 * `unratedArtistPickIds` 约 0.2–1.3 s。放在主线程上，它们每一次都让所有请求一起排队。
 */
export const READ_FNS = {
  knn,
  searchByTextVector,
  countPosts,
  countByColumn,
  countByScorerBucket: countByScorerBucketNamed,
  countByTagFast,
  countAllTags: countAllTagsCancellable,
  aggregateStats,
  folderScoreAggregates,
  unratedArtistPickIds,
} satisfies Record<string, (db: SqliteHandle, ...args: any[]) => unknown>

export type ReadFnName = keyof typeof READ_FNS

/** 去掉第一个参数（连接）之后的参数表。可选参数保持可选。 */
export type ReadArgs<K extends ReadFnName> = Parameters<typeof READ_FNS[K]> extends [unknown, ...infer R] ? R : never

export type ReadResult<K extends ReadFnName> = ReturnType<typeof READ_FNS[K]>

export const READ_FN_NAMES = Object.keys(READ_FNS) as ReadFnName[]

/**
 * 走慢通道的读：它们有专用线程（`createReadPool` 的 `slowSize`），排队也排在自己的队里，
 * 于是一个几秒的 facet 计数挡不住 KNN 和轻计数。
 */
export const SLOW_READS: ReadonlySet<ReadFnName> = new Set<ReadFnName>(['countAllTags'])

/**
 * 同参数并发调用合并成一次派发的读：参数是小的普通数据（过滤器、数字），拼 key 不花钱。
 * `searchByTextVector` 不在里面：参数里有 Float32Array，JSON 化又贵又难得重复。
 */
export const DEDUPED_READS: ReadonlySet<ReadFnName> = new Set<ReadFnName>([
  'knn',
  'countPosts',
  'countByColumn',
  'countByScorerBucket',
  'countByTagFast',
  'countAllTags',
  'aggregateStats',
  'folderScoreAggregates',
  'unratedArtistPickIds',
])
