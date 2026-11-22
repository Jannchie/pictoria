/**
 * URL（gallery-dl）导入的状态机 —— `/v2/cmd/import-from-url` 背后的那个东西。
 *
 * 从 `routes/commands.ts` 搬出来，同 `danbooru-imports.ts`：`createApp`（`app.ts`）和
 * `env.ts` 都要拿这个类，它们不该反过来依赖一个路由文件。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { CairnQ } from 'cairnq'
import type { TaskSource } from './env.js'
import path from 'node:path'
import { IO_QUEUE, urlDownloadTask, urlScanTask } from '@pictoria/contracts'
import { ensureCanonicalTagGroups, listImportedFileNamesInDir, persistPostsWithTags } from '@pictoria/db'
import { IMPORT_CHUNK_SIZE, runInChunks } from './chunked-import.js'
import { createLogger } from './log.js'
import { targetDir } from './paths.js'
import { startSync } from './sync.js'

const urlImportLog = createLogger('url-import')
interface UrlImportStats { fetched: number, images: number, new: number, downloaded: number, failed: number }

/**
 * `/v2/cmd/import-from-url/status` 的 JSON。响应的 zod schema（`UrlImportStatus`）在
 * `routes/commands.ts`，这里是它要接住的形状 —— 每个字段都给出值，不靠 schema 的默认值。
 */
export interface UrlImportStatusBody {
  state: 'idle' | 'running' | 'done' | 'failed'
  url: string | null
  stats: UrlImportStats | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

interface RunningUrlImport {
  kind: 'running'
  url: string
  startedAt: string
  /** 扫描回来之前是 null；之后下载阶段的数字原地更新，前端轮询看得到进度。 */
  stats: UrlImportStats | null
}

/**
 * 当前 / 上一次 URL 导入的阶段。不落库，重启即回到 idle。前端靠轮询拿进度。
 *
 * 原来是一个六个字段的扁平对象（`state` + 五个可空字段），"done 却没有 finishedAt"
 * "running 却带着上一次的 error"都写得出来，转移又散在路由、`runUrlImport`、
 * `importOnce` 三处。现在每个阶段只带它有的字段，转移只发生在 `UrlImports` 里；
 * 对外的 JSON 形状不变，由 `urlImportBody` 摊平。
 */
type UrlImport
  = | { kind: 'idle' }
    | RunningUrlImport
    | (Omit<RunningUrlImport, 'kind'> & { kind: 'done', finishedAt: string })
    | (Omit<RunningUrlImport, 'kind'> & { kind: 'failed', finishedAt: string, error: string })

/** 摊平成 `/v2/cmd/import-from-url/status` 的 JSON：不属于这个阶段的字段一律 null。 */
function urlImportBody(s: UrlImport): UrlImportStatusBody {
  if (s.kind === 'idle')
    return { state: 'idle', url: null, stats: null, error: null, startedAt: null, finishedAt: null }
  return {
    state: s.kind,
    url: s.url,
    stats: s.stats,
    error: s.kind === 'failed' ? s.error : null,
    startedAt: s.startedAt,
    finishedAt: s.kind === 'running' ? null : s.finishedAt,
  }
}

/**
 * URL 导入的状态机：同一时刻最多一次导入。每个 app 一个实例（纯内存）。
 *
 * 原来是模块级的一个 `let`，于是同一进程里的所有 app（测试里每个用例一个）共享一份
 * 状态。现在和 `DanbooruImports` 一样由 `createApp` 注入成 `c.var.urlImports`。
 */
export class UrlImports {
  private state: UrlImport = { kind: 'idle' }

  constructor(
    private readonly db: SqliteHandle,
    private readonly tasks: TaskSource,
  ) {}

  status(): UrlImportStatusBody {
    return urlImportBody(this.state)
  }

  /**
   * 开始一次导入；已有一次在跑时返回 false，什么也不做。
   *
   * 同步换掉整个状态值，于是"忙不忙"的判断在单线程事件循环上没有竞态。
   */
  start(url: string): boolean {
    if (this.state.kind === 'running')
      return false
    const run: RunningUrlImport = { kind: 'running', url, startedAt: new Date().toISOString(), stats: null }
    this.state = run
    void this.run(run)
    return true
  }

  /**
   * 后台跑一次 gallery-dl 导入。
   *
   * 三步，中间那步必须回到 TS：扫描（worker 跑 gallery-dl）→ **按目录去重**
   * （读库）→ 下载 + 落库。gallery-dl 是个 Python 工具，所以扫描和下载只能在
   * worker；去重是数据库读，所以只能在这里。
   */
  private async run(run: RunningUrlImport): Promise<void> {
    const { url } = run
    try {
      await importOnce(this.db, this.tasks, run)
    }
    catch (err) {
      this.state = { ...run, kind: 'failed', finishedAt: new Date().toISOString(), error: String(err) }
      urlImportLog.error(`${url} 失败：${String(err)}`)
      return
    }
    this.state = { ...run, kind: 'done', finishedAt: new Date().toISOString() }
    // 新图需要向量 / 分数 / 自动标签（kemono 的帖子根本不带标签）—— 踢一脚既有的
    // backfill 流程。已经有一轮在跑时 `startSync` 排一次补跑，新文件同样会被扫到。
    startSync(this.db)
  }
}

/** 一块的下载超时。worker 16 线程并发、单张 60 s 超时，50 张一块 10 分钟绰绰有余。 */
const URL_IMPORT_CHUNK_TIMEOUT_MS = 10 * 60_000

/**
 * 一次导入的三步。只往 `run.stats` 里记进度，不碰阶段 —— 阶段归 `UrlImports`。
 *
 * 单独一个函数是为了让"没有可导的东西"能用 `return` 干净地退出，而不会顺带跳过
 * 外面那句转入 done —— 第一版把两者写在一起，结果空结果的导入永远停在
 * `running`，前端会一直转圈。
 */
async function importOnce(sqlite: SqliteHandle, source: TaskSource, run: RunningUrlImport): Promise<void> {
  const { url } = run
  const tasks: CairnQ = await source.get()

  const scan = await tasks.call(urlScanTask, { url }, {
    queue: IO_QUEUE,
    timeoutMs: 30 * 60_000,
    pollMs: 200,
    maxAttempts: 1,
  })
  const stats: UrlImportStats = { fetched: scan.fetched, images: scan.items.length, new: 0, downloaded: 0, failed: 0 }
  run.stats = stats
  if (!scan.items.length)
    return

  // 一个目录下已经被导入器持久化过的 file_name。判据是"行存在且 source 非空"，不是
  // "行存在"：下载中途失败时落了盘的文件会被 sync 建成裸行，按行存在去重会让重跑永远
  // 跳过它们、标签再也补不上（见 listImportedFileNamesInDir）。
  const imported = new Set(listImportedFileNamesInDir(sqlite, scan.filePath))
  const fresh = scan.items.filter((it: { fileName: string }) => !imported.has(it.fileName))
  stats.new = fresh.length
  if (!fresh.length)
    return

  const saveDir = path.resolve(targetDir(), scan.filePath)
  const typeToGroupId = ensureCanonicalTagGroups(sqlite)
  // 串行分块、每块落库、块失败继续 —— 与 Danbooru 导入同一个循环（`chunked-import.ts`）。
  // 失败那一块的文件会在下一次导入里被重新认作"新"（上面的判据）补全。
  const { lastError } = await runInChunks(fresh, IMPORT_CHUNK_SIZE, {
    label: url,
    log: urlImportLog,
    run: async (chunk) => {
      const result = await tasks.call(urlDownloadTask, {
        items: chunk,
        saveDir,
        filePathStr: scan.filePath,
        typeToGroupId,
      }, {
        queue: IO_QUEUE,
        timeoutMs: URL_IMPORT_CHUNK_TIMEOUT_MS,
        pollMs: 200,
        maxAttempts: 1,
      })
      // worker 只回字节已落盘的行，所以这里落库不会早于文件。
      persistPostsWithTags(sqlite, result.rows)
      stats.downloaded += result.downloaded
      stats.failed += result.failed
    },
    onError: (chunk) => {
      stats.failed += chunk.length
    },
  })
  // 一块都没成：这是导入失败（worker 不在、站点封了），不是"完成但全部失败"。
  if (lastError !== undefined && stats.downloaded === 0)
    throw lastError
}
