/**
 * `/v2/cmd/*` —— 命令式端点：它们不是资源的 CRUD，而是"去做一件事"。
 *
 * 每一个背后都拴着一段 Python 计算。端点只负责挑活、提交 cairnq 任务、把结果写回，
 * 具体算什么在 Python worker 那边。
 */
import type { Context } from 'hono'
import type { CairnQ } from 'cairnq'
import { createRoute, z } from '@hono/zod-openapi'
import {
  captionTask,
  IO_QUEUE,
  urlDownloadTask,
  urlScanTask,
} from '@pictoria/contracts'
import {
  type AestheticScorerName,
  ensureCanonicalTagGroups,
  getAestheticScore,
  getPostPath,
  getWaifuScore,
  isImagePath,
  listImportedFileNamesInDir,
  persistPostsWithTags,
  type SqliteHandle,
  updateField,
  vectorExists,
} from '@pictoria/db'
import path from 'node:path'
import { IMPORT_CHUNK_SIZE, runInChunks } from '../chunked-import.js'
import { DEDUP_THRESHOLD, isRebuilding, rebuildGroups } from '../dedup.js'
import { type AppEnv, newRoutes, type TaskSource } from '../env.js'
import { boolQuery, CREATED, OK, errors, fail, postNotFound } from '../openapi.js'
import { postDetailResponse, postIdParam } from './post-shared.js'
import { PostDetailPublic, Result } from '../schemas.js'
import { postAbsPath, targetDir } from '../paths.js'
import { startSync } from '../sync.js'
import { embeddingSpec, runOneShot, silvaSpecs, taggerSpec, waifuSpec } from '../workers.js'

export const commandsRoutes = newRoutes()

/**
 * 即时命令共用的两道守卫：post 不存在 → 404，不是图片 → 400。
 * 先查存在再判类型，所以一个不存在的 id 永远是 404 而不是 400。
 */
function requireImage(sqlite: SqliteHandle, postId: number) {
  const post = getPostPath(sqlite, postId)
  if (!post)
    return { ok: false as const, response: postNotFound(postId) }
  if (!isImagePath(post.fullPath))
    return { ok: false as const, response: notAnImage(postId) }
  return { ok: true as const, item: { postId, relPath: post.fullPath } }
}

/** "扩展名像图片"和"解码器能读"是两件事：算完仍然没有分，也归到这一句。 */
function notAnImage(postId: number) {
  return fail(400, 'NotAnImageError', `Post ${postId} is not an image.`)
}

// 一张图的即时任务（waifu / silva / 自动标签）走 `workers.ts` 的 `runOneShot`：与 backfill
// 同一份 payload 组装和落库，key 是 `<worker>:one:<id>`、conflict 用默认 `'reuse'`、
// 失败不拉黑。为什么是这套参数见那边的注释。

commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/group-duplicates',
    operationId: 'v2GroupDuplicates',
    summary: 'GroupDuplicates',
    description: 'Rebuild near-duplicate groups (posts.canonical_post_id) from SigLIP2 similarity.',
    request: {
      query: z.object({
        threshold: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'threshold', in: 'query', required: false }, type: ['number', 'null'] }),
        grey_threshold: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'grey_threshold', in: 'query', required: false }, type: ['number', 'null'] }),
        lpips_threshold: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'lpips_threshold', in: 'query', required: false }, type: ['number', 'null'] }),
        max_group_size: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'max_group_size', in: 'query', required: false }, type: ['number', 'null'] }),
        max_arbitrations: z.coerce.number().nullable().optional()
          .openapi({ param: { name: 'max_arbitrations', in: 'query', required: false }, type: ['number', 'null'] }),
        // dry run 走完整流程（含 GPU 召回和 LPIPS 仲裁，仲裁结果照常写进证据表 ——
        // 那是缓存，算了就该留下），只是不动 canonical_post_id。用来在真正改变界面
        // 之前，先从日志里看一眼"这一轮会多合并多少、组大小分布长什么样"。
        dry_run: boolQuery('dry_run', false),
        // spread = 在整条灰带上均匀取样，用来标定阈值；nearest = 先算最像的，用来收敛。
        arbitration_sampling: z.enum(['nearest', 'spread']).optional()
          .openapi({ param: { name: 'arbitration_sampling', in: 'query', required: false } }),
      }),
    },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: Result } } },
      ...errors(400),
    },
  }),
  async (c) => {
    const {
      threshold,
      grey_threshold: greyThreshold,
      lpips_threshold: lpipsThreshold,
      max_group_size: maxGroupSize,
      max_arbitrations: maxArbitrations,
      arbitration_sampling: arbitrationSampling,
      dry_run: dryRun,
    } = c.req.valid('query')
    // ⚠️ 必须在忙检查**之前** await。检查和启动之间夹一个 await，两个几乎同时到达
    // 的请求就会双双通过检查，然后排成两次全量重算 —— 一次分钟级的 GPU 白烧。
    // 先把这个 await 做掉，检查和启动就都落在同一个同步片段里。
    const tasks = await c.var.tasks.get()

    // 忙就报忙，不排队。
    if (isRebuilding())
      return c.json({ msg: 'Near-duplicate grouping already running' }, 201)

    // 直接传，不逐个 `...(x == null ? {} : { x })`：`RebuildOptions` 的每一项都收
    // null，默认值在 `doRebuild` 里用 `??` 兜。加一个旋钮只要加一行。
    const opts = {
      threshold,
      greyThreshold,
      lpipsThreshold,
      maxGroupSize,
      maxArbitrations,
      arbitrationSampling,
      dryRun,
    }
    // fire-and-forget：请求立刻返回，结果打进日志。失败在这里吞掉并记下 ——
    // 没有人在等这个 promise，未处理的 rejection 会让整个进程退出。
    void rebuildGroups(c.var.db, tasks, opts)
      .catch((err: unknown) => console.warn(`[dedup] 重建失败：${String(err)}`))

    const thr = threshold ?? DEDUP_THRESHOLD
    return c.json({
      msg: `Near-duplicate grouping started (threshold=${thr}${dryRun ? ', dry run' : ''}).`,
    }, 201)
  },
)

/**
 * waifu 质量分：算一张、存一张、返回它。
 *
 * 已经有分就直接返回存的，不重算 —— 用户点这个按钮是想看分数，不是想烧 GPU。
 * 算完仍然没有分意味着 worker 没能把它当成图片读进来，报 400。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/cmd/waifu-scorer/{post_id}',
    operationId: 'v2GetWaifuScorerOne',
    summary: 'GetWaifuScorerOne',
    description: 'Compute (and persist) the waifu score for a single post. Missing post -> 404, non-image -> 400, already scored -> the stored score without recomputing.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.number() } } },
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const guard = requireImage(c.var.db, postId)
    if (!guard.ok)
      return guard.response

    const sqlite = c.var.db
    const existing = getWaifuScore(sqlite, postId)
    if (existing !== null)
      return c.json(existing, 200)

    const tasks: CairnQ = await c.var.tasks.get()
    await runOneShot(sqlite, tasks, waifuSpec, [guard.item])

    const score = getWaifuScore(sqlite, postId)
    if (score === null)
      return notAnImage(postId)
    return c.json(score, 200)
  },
)

/**
 * SILVA / SILVA-Luna：两个蒸馏头共用这一段，只有 scorer 名不同。
 *
 * 输入是已存的 SigLIP2 向量。没有向量就**先算向量**再打分，这样用户点一次就能
 * 拿到结果，而不是"请稍后再试"。
 */
function silvaOneShot(scorer: AestheticScorerName) {
  return async (c: Context<AppEnv, any, any>) => {
    const { post_id: postId } = c.req.valid('param') as { post_id: number }
    const guard = requireImage(c.var.db, postId)
    if (!guard.ok)
      return guard.response

    const sqlite = c.var.db
    const existing = getAestheticScore(sqlite, postId, scorer)
    if (existing !== null)
      return c.json(existing, 200)

    const tasks: CairnQ = await c.var.tasks.get()
    if (!vectorExists(sqlite, postId))
      await runOneShot(sqlite, tasks, embeddingSpec, [guard.item])
    // 向量算不出来 = 这张图读不进来。和 waifu 一样报 400。（silva 的 payload 组装
    // 在没有向量时给出空 items，`runOneShot` 据此不提交、返回 null。）
    if (await runOneShot(sqlite, tasks, silvaSpecs[scorer], [{ postId }]) === null)
      return notAnImage(postId)

    const score = getAestheticScore(sqlite, postId, scorer)
    if (score === null)
      return notAnImage(postId)
    return c.json(score, 200)
  }
}

commandsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/cmd/silva-scorer/{post_id}',
    operationId: 'v2GetSilvaScorerOne',
    summary: 'GetSilvaScorerOne',
    description: 'Compute (and persist) the SILVA score for one post from its embedding.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.number() } } },
      ...errors(400, 404),
    },
  }),
  silvaOneShot('silva'),
)

commandsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/cmd/silva-luna-scorer/{post_id}',
    operationId: 'v2GetSilvaLunaScorerOne',
    summary: 'GetSilvaLunaScorerOne',
    description: 'Compute (and persist) the SILVA-Luna score for one post from its embedding.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.number() } } },
      ...errors(400, 404),
    },
  }),
  silvaOneShot('silva_luna'),
)

/**
 * 自动标签：跑 PixAI Tagger，标签和 rating 落库，返回最新详情。
 *
 * 这里只查 post 存不存在，**没有** `is_image` 守卫：那道守卫按扩展名判，多加上会让
 * 今天能标注的某种扩展名突然 400；非图片走到 worker 那里失败是 500，也说得清。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/cmd/auto-tags/{post_id}',
    operationId: 'v2AutoTags',
    summary: 'AutoTags',
    description: 'Auto tag a post',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...errors(400, 404, 500),
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const sqlite = c.var.db
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId)

    const tasks: CairnQ = await c.var.tasks.get()
    // 落库走 tagger 规格的交互模式：rating 无条件覆盖，被手工标签遮住的不拉黑
    // （见 `workers.ts` 的 `taggerSpec`）。没有结果时落库是空操作。
    const result = (await runOneShot(sqlite, tasks, taggerSpec, [{ postId, relPath: post.fullPath }]))!

    // worker 把"读不出来"和"标签全空"都算失败。这里不能当成"标注完了但没标签"
    // 静默返回 200 —— 那会让前端以为标注成功而实际上一个字都没写。让它 500。
    if (!result.results[0]) {
      const why = result.failures[0]?.error ?? 'tagger returned no result'
      return fail(500, 'AutoTagsFailedError', `auto-tags failed for post ${postId}: ${why}`)
    }
    return postDetailResponse(c, postId)
  },
)

/**
 * 自动配文：跑 OpenAI，把结果写进 `posts.caption`，回读详情。
 *
 * worker 把"没配 key"作为**数据**回传而不是抛异常 —— 那不是一次值得重试的失败，
 * 是一句该由 HTTP 层措辞的话。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/cmd/auto-caption/{post_id}',
    operationId: 'v2AutoCaption',
    summary: 'AutoCaption',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...errors(400, 404),
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const sqlite = c.var.db
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId)

    const tasks: CairnQ = await c.var.tasks.get()
    const result = await tasks.call(captionTask, {
      imagePath: postAbsPath(post.fullPath),
    }, { queue: IO_QUEUE, timeoutMs: 120_000, maxAttempts: 1 })

    if (!result.configured)
      return fail(400, 'MissingConfigError', 'OpenAI API key is not set.')

    updateField(sqlite, postId, 'caption', result.caption)
    return postDetailResponse(c, postId)
  },
)

/**
 * 重扫 target_dir 并把每个 backfill worker 都推一把。
 *
 * fire-and-forget：立刻返回，不让 HTTP 客户端干等一次几分钟的扫描。忙检查让
 * 连点这个按钮（或在上一次还没跑完时再点）成为空操作，而不是启动重复的活。
 *
 * `?allow_mass_delete=true` 按次放行超比例删除（`sync.ts` 的第二道闸门）—— 这是
 * 那道闸门的警告日志里指的确认动作。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/sync-metadata',
    operationId: 'v2SyncMetadataEndpoint',
    summary: 'SyncMetadataEndpoint',
    description: 'Rescan target_dir and run every backfill worker',
    request: {
      query: z.object({ allow_mass_delete: boolQuery('allow_mass_delete', false) }),
    },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: Result } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { allow_mass_delete: allowMassDelete } = c.req.valid('query')
    // 新行的空列由 backfill 循环去填：建行的 repository 函数自己叫醒它们。
    const started = startSync(c.var.db, (r) => {
      console.warn(`[sync] 完成：新增 ${r.added}，删除 ${r.removed}`)
    }, { allowMassDelete })
    return c.json({ msg: started === 'started' ? 'Sync started' : 'Sync already running' }, 201)
  },
)

const GalleryDLStats = z
  .object({
    fetched: z.int().default(0),
    images: z.int().default(0),
    new: z.int().default(0),
    downloaded: z.int().default(0),
    failed: z.int().default(0),
  })
  .openapi('GalleryDLStats')

const UrlImportStatus = z
  .object({
    state: z.enum(['idle', 'running', 'done', 'failed']).default('idle'),
    url: z.string().nullable().optional(),
    stats: z.union([GalleryDLStats, z.null()]).optional(),
    error: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
  })
  .openapi('UrlImportStatus')

interface UrlImportStats { fetched: number, images: number, new: number, downloaded: number, failed: number }

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
function urlImportBody(s: UrlImport): z.infer<typeof UrlImportStatus> {
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
 * 状态。理想的做法是像 `DanbooruImports` 那样由 `createApp` 注入成 `c.var.urlImports`；
 * 在那之前，`urlImportsFor` 按库连接取实例 —— 一个 app 恰好一条连接，效果相同。
 */
export class UrlImports {
  private state: UrlImport = { kind: 'idle' }

  constructor(
    private readonly db: SqliteHandle,
    private readonly tasks: TaskSource,
  ) {}

  status(): z.infer<typeof UrlImportStatus> {
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
      console.warn(`[url-import] ${url} 失败：${String(err)}`)
      return
    }
    this.state = { ...run, kind: 'done', finishedAt: new Date().toISOString() }
    // 新图需要向量 / 分数 / 自动标签（kemono 的帖子根本不带标签）—— 踢一脚既有的
    // backfill 流程。已经有一轮在跑时 `startSync` 排一次补跑，新文件同样会被扫到。
    startSync(this.db)
  }
}

const urlImportsByDb = new WeakMap<SqliteHandle, UrlImports>()

/** 这个 app（= 这条库连接）的 URL 导入实例。 */
function urlImportsFor(c: Context<AppEnv, any, any>): UrlImports {
  let inst = urlImportsByDb.get(c.var.db)
  if (!inst) {
    inst = new UrlImports(c.var.db, c.var.tasks)
    urlImportsByDb.set(c.var.db, inst)
  }
  return inst
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
    label: `[url-import] ${url}`,
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

commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/import-from-url',
    operationId: 'v2ImportFromUrlEndpoint',
    summary: 'ImportFromUrlEndpoint',
    description: 'Fetch a creator/tag URL via gallery-dl in the background and persist new images',
    request: {
      query: z.object({
        // 只收 http(s)：这个值原样交给 gallery-dl，`file:` / `-` 开头的值会被它当成本地路径
        // 或命令行选项（Python 侧另在 url 前加了 `--`，两道各管一层）。
        url: z.string().regex(/^https?:\/\//i, 'url must start with http:// or https://')
          .openapi({ param: { name: 'url', in: 'query', required: true } }),
      }),
    },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: Result } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { url } = c.req.valid('query')
    if (!urlImportsFor(c).start(url))
      return c.json({ msg: 'Import already running' }, 201)
    return c.json({ msg: 'Import started' }, 201)
  },
)

commandsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/cmd/import-from-url/status',
    operationId: 'v2ImportFromUrlStatus',
    summary: 'ImportFromUrlStatus',
    description: 'Status of the current/last background URL import',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: UrlImportStatus } } },
    },
  }),
  c => c.json(urlImportsFor(c).status(), 200),
)
