/**
 * Danbooru 标签导入的后台作业队列 —— `/v2/danbooru-imports` 背后的那个东西。
 *
 * 为什么不再是"一个请求等一次导入跑完"：CDN 被限到约 1 req/s，新图多于一百多张的标签
 * 一次导入就是十几分钟，调用方（`scripts/run_get_artist_data.py`）的读超时先到。而
 * 客户端超时**不会**取消服务端任务，重试又提交了第二个同标签的导入 —— `importedIds`
 * 在提交时读库，原任务还没落库，于是两次的列表几乎一样，两三个导入抢同一份 CDN 配额、
 * 同一个 `.part` 文件，占满 IO 队列，越重试越慢。
 *
 * 这里的三条规矩各治一样：
 *
 * * **同一个 tags 同时只有一个作业**（queued 或 running）。重复提交拿回的是那一个，
 *   所以重试永远不会制造第二个并行导入。
 * * **已导入 id 在作业开始跑时才读**，不是提交时 —— 排在后面的作业能看到前面作业
 *   落的库。
 * * **分块下载、每块落一次库**：有进度可看，中途失败也只丢那一块（而它的文件若已落盘，
 *   下次运行下载会 skip 并照样回传行，自愈）。
 *
 * 纯内存，不落库：API 重启作业就丢了。那没关系 —— 导入本身幂等，脚本那一侧轮询到
 * 404 会重新提交。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { CairnQ } from 'cairnq'
import type { TaskSource } from './env.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  DANBOORU_LISTING_LIMIT,
  danbooruDownloadTask,
  type DanbooruItem,
  danbooruListTask,
  IO_QUEUE,
} from '@pictoria/contracts'
import { ensureCanonicalTagGroups, listImportedDanbooruIds, persistPostsWithTags } from '@pictoria/db'
import { targetDir } from './paths.js'

export type DanbooruImportState = 'queued' | 'running' | 'done' | 'failed'
export type DanbooruImportPhase = 'listing' | 'downloading'

/** 一个导入作业。也是 API 回的 JSON。 */
export interface DanbooruImportJob {
  id: string
  tags: string
  fullScan: boolean
  state: DanbooruImportState
  /** 只在 running 时非 null。 */
  phase: DanbooruImportPhase | null
  /** 列表一共回了多少条。 */
  total: number
  /** 其中带 `file_url` 的。 */
  withUrl: number
  /** 其中这个导入器收的（支持的图片）。 */
  filtered: number
  /** 列表阶段得出的待下载数 —— 进度条的分母。 */
  pending: number
  /** 下载阶段已经处理完的条数（成功、跳过、失败都算）—— 进度条的分子。 */
  processed: number
  downloaded: number
  /** `filtered - pending`（已经导入过的），加上下载阶段文件已在盘上的。 */
  skipped: number
  failed: number
  earlyStopped: boolean
  /** 列表失败时是失败原因；下载块失败时是最后一次块错误（作业仍是 done）。 */
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface DanbooruImportsOptions {
  /** 同时 running 的作业上限。默认 2 —— 再多只是把同一份 CDN 配额劈得更碎。 */
  concurrency?: number
  /** 下载一块多少条。默认 50，按 ~1 req/s 约一分钟落一次库。 */
  chunkSize?: number
  /** 已结束的作业保留多久。默认 6 小时。 */
  retainMs?: number
  /** 已结束的作业最多保留多少个。默认 1000。 */
  maxRetained?: number
}

/**
 * 列表阶段的超时。大的版权/角色标签要翻上几分钟（`DANBOORU_LISTING_LIMIT` 封顶），
 * API 那道闸被限流时还会再等。
 */
const LIST_TIMEOUT_MS = 30 * 60_000

/**
 * 一块下载的超时。50 条按 ~1 req/s 是一分钟上下；被 CDN 冷却时每条最多再耗
 * `_MAX_THROTTLE_SECONDS`（120 s），但那是全池共享的冷却，不按条数叠加。
 */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000

/**
 * Windows 不允许文件名里出现 `<>:"/\|?*`；`re:rin` 这种 Danbooru 标签否则会
 * mkdir 失败。控制字符一并替换掉，尾部的点和空格也要削掉（Windows 不允许）。
 */
export function safeDirName(name: string): string {
  let out = ''
  for (const ch of name)
    out += '<>:"/\\|?*'.includes(ch) || ch < ' ' ? '_' : ch
  return out.replace(/[.\s]+$/, '') || '_'
}

function isActive(job: DanbooruImportJob): boolean {
  return job.state === 'queued' || job.state === 'running'
}

export class DanbooruImports {
  private readonly concurrency: number
  private readonly chunkSize: number
  private readonly retainMs: number
  private readonly maxRetained: number

  /** 全部作业，插入顺序 = 创建顺序。 */
  private readonly jobs = new Map<string, DanbooruImportJob>()
  /** tags → 它那个 queued / running 的作业。去重就靠这张表。 */
  private readonly active = new Map<string, DanbooruImportJob>()
  private readonly queue: DanbooruImportJob[] = []
  private running = 0
  private idleWaiters: Array<() => void> = []

  constructor(
    private readonly db: SqliteHandle,
    private readonly tasks: TaskSource,
    opts: DanbooruImportsOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
    this.chunkSize = Math.max(1, opts.chunkSize ?? 50)
    this.retainMs = opts.retainMs ?? 6 * 60 * 60_000
    this.maxRetained = opts.maxRetained ?? 1000
  }

  /**
   * 提交一个标签。`tags` 由调用方 trim 过、非空。
   *
   * 已有同 tags 的 queued / running 作业就直接返回它 —— 这是整个模块存在的理由。
   * 例外只有一种升级：排着队的增量作业遇上一个 fullScan 请求，就地改成 fullScan
   * （它还没开始翻页，改了不浪费任何东西）；已经在跑的不动，fullScan 请求等它结束
   * 后再提交一次即可。
   */
  submit(tags: string, fullScan: boolean): DanbooruImportJob {
    const existing = this.active.get(tags)
    if (existing) {
      if (existing.state === 'queued' && fullScan && !existing.fullScan)
        existing.fullScan = true
      return { ...existing }
    }

    const job: DanbooruImportJob = {
      id: randomUUID(),
      tags,
      fullScan,
      state: 'queued',
      phase: null,
      total: 0,
      withUrl: 0,
      filtered: 0,
      pending: 0,
      processed: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      earlyStopped: false,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    }
    this.jobs.set(job.id, job)
    this.active.set(tags, job)
    this.queue.push(job)
    this.prune()
    this.pump()
    return { ...job }
  }

  get(id: string): DanbooruImportJob | null {
    const job = this.jobs.get(id)
    return job ? { ...job } : null
  }

  /** 最近创建的在前。 */
  list(): DanbooruImportJob[] {
    return [...this.jobs.values()].reverse().map(j => ({ ...j }))
  }

  /** 队列排空、没有作业在跑时 resolve。测试用来等后台作业结束。 */
  idle(): Promise<void> {
    if (this.isIdle())
      return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private isIdle(): boolean {
    return this.running === 0 && this.queue.length === 0
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      this.running++
      void this.run(job)
    }
  }

  /**
   * 跑一个作业，并且**无论如何**把它收尾。
   *
   * 收尾全在 `finally`：置 finishedAt、让出并发槽、继续 pump。`execute` 里任何一处
   * `return`（列表为空、没有待下载）都不会跳过它 —— URL 导入第一版就是把提前退出和
   * 收尾写在一起，结果空结果的导入永远停在 running（见 `routes/commands.ts` 的
   * `importOnce`）。
   */
  private async run(job: DanbooruImportJob): Promise<void> {
    job.state = 'running'
    job.startedAt = new Date().toISOString()
    try {
      await this.execute(job)
      job.state = 'done'
      console.warn(
        `[danbooru-import] ${job.tags} 完成：下载 ${job.downloaded}，跳过 ${job.skipped}，失败 ${job.failed}`,
      )
    }
    catch (err) {
      job.state = 'failed'
      job.error = String(err)
      console.warn(`[danbooru-import] ${job.tags} 失败：${String(err)}`)
    }
    finally {
      job.phase = null
      job.finishedAt = new Date().toISOString()
      if (this.active.get(job.tags) === job)
        this.active.delete(job.tags)
      this.running--
      this.prune()
      this.pump()
      if (this.isIdle()) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const resolve of waiters) resolve()
      }
    }
  }

  private async execute(job: DanbooruImportJob): Promise<void> {
    job.phase = 'listing'
    const tasks: CairnQ = await this.tasks.get()

    const filePathStr = `danbooru/${safeDirName(job.tags)}`
    const saveDir = path.resolve(targetDir(), filePathStr)
    // ⚠️ 在**开始跑**时读，不是提交时：排在同标签上一个作业后面的那次重提，要看到
    // 上一个作业已经落的库，否则它的列表会和上一个几乎一样。
    const listing = await tasks.call(danbooruListTask, {
      tags: job.tags,
      limit: DANBOORU_LISTING_LIMIT,
      fullScan: job.fullScan,
      importedIds: listImportedDanbooruIds(this.db, filePathStr),
      filePathStr,
      typeToGroupId: ensureCanonicalTagGroups(this.db),
    }, { queue: IO_QUEUE, timeoutMs: LIST_TIMEOUT_MS, pollMs: 500, maxAttempts: 1 })

    const { stats, items } = listing
    job.total = stats.total
    job.withUrl = stats.withUrl
    job.filtered = stats.filtered
    job.earlyStopped = stats.earlyStopped
    job.pending = items.length
    job.skipped = stats.filtered - items.length

    job.phase = 'downloading'
    // 块是**串行**的：一个作业同时只占 IO 队列的一个槽，CDN 配额由全部作业共享，
    // 并行下同一个作业的两块不会更快，只会让别的作业排更久。
    for (let i = 0; i < items.length; i += this.chunkSize) {
      const chunk: DanbooruItem[] = items.slice(i, i + this.chunkSize)
      try {
        const result = await tasks.call(danbooruDownloadTask, { items: chunk, saveDir }, {
          queue: IO_QUEUE,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          pollMs: 500,
          maxAttempts: 1,
        })
        // 每块回来立刻落库：行只含字节已落盘的那些（worker 保证），新行的空列由
        // backfill 去填 —— persistPostsWithTags 自己叫醒循环。
        persistPostsWithTags(this.db, result.rows)
        job.downloaded += result.downloaded
        job.skipped += result.skipped
        job.failed += result.failed
      }
      catch (err) {
        // 一块失败不中断整个作业：整块记为失败，接着下一块。这块里已经落盘、却没落库
        // 的文件，下次运行下载会 skip 并照样回传行。
        job.failed += chunk.length
        job.error = String(err)
        console.warn(`[danbooru-import] ${job.tags} 第 ${i / this.chunkSize + 1} 块失败：${String(err)}`)
      }
      job.processed += chunk.length
    }
  }

  /** 清理已结束的旧作业：超过 retainMs 的，以及超出 maxRetained 的最老那些。 */
  private prune(): void {
    const cutoff = Date.now() - this.retainMs
    const finished: DanbooruImportJob[] = []
    for (const job of this.jobs.values()) {
      if (isActive(job))
        continue
      if (Date.parse(job.finishedAt!) < cutoff)
        this.jobs.delete(job.id)
      else
        finished.push(job)
    }
    // finished 按创建顺序排列，最老的在前。
    for (const job of finished.slice(0, Math.max(0, finished.length - this.maxRetained)))
      this.jobs.delete(job.id)
  }
}
