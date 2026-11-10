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
 *   下次运行下载会 skip 并照样报告为已落盘，自愈）。
 *
 * 纯内存，不落库：API 重启作业就丢了。那没关系 —— 导入本身幂等，脚本那一侧轮询到
 * 404 会重新提交。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { CairnQ } from 'cairnq'
import type { TaskSource } from './env.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from '@hono/zod-openapi'
import {
  DANBOORU_LISTING_LIMIT,
  danbooruDownloadTask,
  type DanbooruItem,
  danbooruListTask,
  IO_QUEUE,
} from '@pictoria/contracts'
import { ensureCanonicalTagGroups, listImportedDanbooruIds, persistPostsWithTags } from '@pictoria/db'
import { IMPORT_CHUNK_SIZE, runInChunks } from './chunked-import.js'
import { targetDir } from './paths.js'

/**
 * 一个导入作业，也是 API 回的 JSON —— 形状只在这里定义一次，类型由它推导，路由直接
 * 拿它当响应 schema。`.openapi(...)` 的描述会进 OpenAPI 文档；只给读代码的人看的补充
 * 写成普通注释。
 */
export const DanbooruImportJobSchema = z
  .object({
    id: z.string(),
    tags: z.string(),
    fullScan: z.boolean(),
    state: z.enum(['queued', 'running', 'done', 'failed']),
    phase: z.enum(['listing', 'downloading']).nullable().openapi({ description: '只在 running 时非 null。' }),
    total: z.int().openapi({ description: '列表一共回了多少条。' }),
    // 其中带 `file_url` 的。
    withUrl: z.int(),
    filtered: z.int().openapi({ description: '其中这个导入器收的（支持的图片）。' }),
    pending: z.int().openapi({ description: '列表阶段得出的待下载数（进度条的分母）。' }),
    // 成功、跳过、失败都算。
    processed: z.int().openapi({ description: '下载阶段已处理的条数（进度条的分子）。' }),
    downloaded: z.int(),
    // = `filtered - pending`，加上下载阶段 skip 的。
    skipped: z.int().openapi({ description: '已经导入过的，加上下载时文件已在盘上的。' }),
    failed: z.int(),
    earlyStopped: z.boolean(),
    error: z.string().nullable().openapi({ description: '列表失败的原因，或最后一次下载块的错误（此时作业仍是 done）。' }),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .openapi('DanbooruImportJob')

export type DanbooruImportJob = z.infer<typeof DanbooruImportJobSchema>

export interface DanbooruImportsOptions {
  /** 同时 running 的作业上限。默认 2 —— 再多只是把同一份 CDN 配额劈得更碎。 */
  concurrency?: number
  /** 下载一块多少条。默认 `IMPORT_CHUNK_SIZE`（50），按 ~1 req/s 约一分钟落一次库。 */
  chunkSize?: number
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
  private readonly maxRetained: number

  /** 全部作业，插入顺序 = 创建顺序。 */
  private readonly jobs = new Map<string, DanbooruImportJob>()
  /**
   * tags → 它那个 queued / running 的作业。去重就靠这张表。排队的也在里面，所以在跑的
   * 个数就是 `active.size - queue.length`，不另外记一个计数器。
   */
  private readonly active = new Map<string, DanbooruImportJob>()
  private readonly queue: DanbooruImportJob[] = []
  private idleWaiters: Array<() => void> = []

  constructor(
    private readonly db: SqliteHandle,
    private readonly tasks: TaskSource,
    opts: DanbooruImportsOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
    this.chunkSize = Math.max(1, opts.chunkSize ?? IMPORT_CHUNK_SIZE)
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
    return this.active.size === 0
  }

  private pump(): void {
    while (this.active.size - this.queue.length < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      void this.run(job)
    }
  }

  /**
   * 跑一个作业，并且**无论如何**把它收尾。
   *
   * 收尾全在 `finally`：置 finishedAt、移出 `active`（这就是让出并发槽）、继续 pump。`execute` 里任何一处
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
      // 必须在 pump / isIdle 之前：在跑的个数是从 active 算出来的。
      if (this.active.get(job.tags) === job)
        this.active.delete(job.tags)
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
    // stats 的键（total / withUrl / filtered / earlyStopped）和作业上的同名。
    Object.assign(job, stats)
    job.pending = items.length
    job.skipped = stats.filtered - items.length

    job.phase = 'downloading'
    // 串行分块、每块落库、块失败继续 —— 规矩见 `chunked-import.ts`。
    await runInChunks<DanbooruItem>(items, this.chunkSize, {
      label: `[danbooru-import] ${job.tags}`,
      run: async (chunk) => {
        // 行留在这边，不跟着下载走：worker 只要知道下什么、存成什么名字。
        const downloadItems = chunk.map(i => ({
          fileUrl: i.fileUrl,
          fileSize: i.fileSize,
          fileName: i.row.fileName,
          extension: i.row.extension,
        }))
        const result = await tasks.call(danbooruDownloadTask, { items: downloadItems, saveDir }, {
          queue: IO_QUEUE,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          pollMs: 500,
          maxAttempts: 1,
        })
        // 每块回来立刻落库，只落 worker 报告字节已落盘的那些 —— 行绝不能早于文件。
        // 本来就在盘上的也在 landed 里，所以上次落盘却没落库的块这次会补上。新行的
        // 空列由 backfill 去填 —— persistPostsWithTags 自己叫醒循环。
        const landed = new Set(result.landed)
        persistPostsWithTags(this.db, chunk.filter(i => landed.has(i.row.fileName)).map(i => i.row))
        job.downloaded += result.downloaded
        job.skipped += result.skipped
        job.failed += result.failed
      },
      // 整块记为失败。这块里已经落盘、却没落库的文件，下次运行下载会 skip 并照样报告为 landed。
      onError: (chunk, err) => {
        job.failed += chunk.length
        job.error = String(err)
      },
      after: (chunk) => {
        job.processed += chunk.length
      },
    })
  }

  /**
   * 已结束的作业超出 maxRetained 时，删掉最老的那些。`jobs` 按插入（= 创建）顺序
   * 迭代，所以从头删就是从最老的删；在跑、排队的跳过。
   */
  private prune(): void {
    let excess = -this.maxRetained
    for (const job of this.jobs.values()) {
      if (!isActive(job))
        excess++
    }
    for (const job of this.jobs.values()) {
      if (excess <= 0)
        return
      if (!isActive(job)) {
        this.jobs.delete(job.id)
        excess--
      }
    }
  }
}
