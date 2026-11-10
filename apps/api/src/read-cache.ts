/**
 * 计数类读的结果缓存，以及路由实际拿到的那份 `c.var.reads`（`AppReads`）。
 *
 * 带过滤的 tag facet（`countAllTags`）在真库上冷算要 0.3–8 s，而同一个过滤器会被反复问：
 * 打开 / 重开下拉框、切 tab、搜索框里每敲一个字（名字筛选在缓存的全量结果上做，见
 * `selectTagCounts`）。其余计数（count / 分档 / stats）几十到几百毫秒，顺手一起缓存。
 *
 * 失效靠**数据版本**而不是 TTL：`total_changes()`（主连接自开库以来改过的行数 —— 整个进程
 * 唯一的写者就是这条连接：路由、调度器、sync 都用它）拼上 `PRAGMA data_version`（别的
 * 连接 —— 一次性脚本 —— 提交过就会变）。两者都是 O(1)。任何写都让全部条目失效，所以
 * 缓存永远不会给出旧数据；代价是 backfill 正在大量落库时几乎命不中，那时和没有缓存一样。
 *
 * 版本在**派发前**读：查询读到的快照不早于这个版本；如果派发后又有写，下次查版本对不上，
 * 自然重算 —— 不会把旧结果挂在新版本上。
 *
 * 每个 app 一个（`createApp` 注入），测试之间不共享。
 */
import type { PostFilter, SqliteHandle, TagCount, TagCountEntry, TagNameMatch } from '@pictoria/db'
import type { ReadFnName } from './read-fns.js'
import type { Reads } from './read-pool.js'
import { isTagCountFastPath, selectTagCounts } from '@pictoria/db'

/**
 * 缓存结果的读。KNN / 文搜图不在里面：参数几乎不重复，结果也大。`folderScoreAggregates`
 * 是目录树的聚合（真库 1.4 s），目录树靠它返回**同一个对象**来判断能不能复用响应体。
 */
const CACHED_READS: ReadonlySet<ReadFnName> = new Set<ReadFnName>([
  'countPosts',
  'countByColumn',
  'countByScorerBucket',
  'aggregateStats',
  'countAllTags',
  'folderScoreAggregates',
])

interface Entry {
  version: string
  value: unknown
  /** tag 全量列表：单条可能有十几万项，单独限条数。 */
  big: boolean
}

export interface ReadCacheOptions {
  /** 总条数上限（LRU）。 */
  maxEntries?: number
  /** tag 全量列表的条数上限（LRU）。 */
  maxTagLists?: number
}

export class ReadCache {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number
  private readonly maxTagLists: number
  private readonly totalChanges: () => number
  private readonly dataVersion: () => number

  constructor(db: SqliteHandle, { maxEntries = 64, maxTagLists = 8 }: ReadCacheOptions = {}) {
    this.maxEntries = maxEntries
    this.maxTagLists = maxTagLists
    const tc = db.prepare<[], number>('SELECT total_changes()').pluck()
    this.totalChanges = () => tc.get()!
    this.dataVersion = () => db.pragma('data_version', { simple: true }) as number
  }

  /** 当前数据版本：任何一次写之后都不同。 */
  version(): string {
    return `${this.totalChanges()}:${this.dataVersion()}`
  }

  get(key: string, version: string): unknown {
    const e = this.entries.get(key)
    if (!e)
      return undefined
    if (e.version !== version) {
      this.entries.delete(key)
      return undefined
    }
    // LRU：命中的挪到队尾。
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.value
  }

  set(key: string, version: string, value: unknown, big: boolean): void {
    this.entries.delete(key)
    this.entries.set(key, { version, value, big })
    let bigCount = 0
    for (const e of this.entries.values()) {
      if (e.big)
        bigCount++
    }
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && bigCount <= this.maxTagLists)
        break
      if (this.entries.size > this.maxEntries || e.big) {
        this.entries.delete(k)
        if (e.big)
          bigCount--
      }
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 路由拿到的读：线程池的方法（计数类带缓存）+ 组合出来的 `countByTag`。 */
export type AppReads = Omit<Reads, 'withSignal'> & {
  /**
   * tag facet：没有内容过滤时走 `tags.post_count` 快路径（毫秒级，不缓存）；否则取缓存的
   * 全量结果（`countAllTags`，慢通道）再在内存里按名字筛、取前 N。
   */
  countByTag: (f: PostFilter, opts?: TagNameMatch) => Promise<TagCount[]>
  withSignal: (signal: AbortSignal | undefined) => AppReads
}

export function createAppReads(reads: Reads, cache: ReadCache): AppReads {
  const wrapped: Record<string, unknown> = { ...reads }
  for (const fn of CACHED_READS) {
    const call = reads[fn] as (...args: unknown[]) => Promise<unknown>
    wrapped[fn] = async (...args: unknown[]) => {
      const key = fn + JSON.stringify(args)
      const version = cache.version()
      const hit = cache.get(key, version)
      if (hit !== undefined)
        return hit
      const value = await call(...args)
      cache.set(key, version, value, fn === 'countAllTags')
      return value
    }
  }
  const app = wrapped as unknown as AppReads
  app.countByTag = async (f, opts = {}) => {
    if (isTagCountFastPath(f))
      return reads.countByTagFast(opts)
    const all = await (app.countAllTags(f) as Promise<TagCountEntry[]>)
    return selectTagCounts(all, opts)
  }
  app.withSignal = signal => createAppReads(reads.withSignal(signal), cache)
  return app
}
