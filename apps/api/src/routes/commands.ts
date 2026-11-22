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
  DEDUP_THRESHOLD,
  IO_QUEUE,
} from '@pictoria/contracts'
import {
  type AestheticScorerName,
  getAestheticScore,
  getPostPath,
  isImagePath,
  type SqliteHandle,
  updateField,
  vectorExists,
} from '@pictoria/db'
import { type AppEnv, newRoutes } from '../env.js'
import { createLogger } from '../log.js'
import { boolQuery, CREATED, OK, errors, fail, postNotFound } from '../openapi.js'
import { postDetailResponse, postIdParam } from './post-shared.js'
import { PostDetailPublic, Result } from '../schemas.js'
import { postAbsPath } from '../paths.js'
import { startSync } from '../sync.js'
import { embeddingSpec, runOneShot, silvaSpecs, taggerSpec } from '../workers.js'

export const commandsRoutes = newRoutes()

const dedupLog = createLogger('dedup')
const syncLog = createLogger('sync')

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

// 一张图的即时任务（silva / 自动标签）走 `workers.ts` 的 `runOneShot`：与 backfill
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
    if (c.var.dedup.isRebuilding())
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
    void c.var.dedup.rebuild(c.var.db, tasks, opts)
      .catch((err: unknown) => dedupLog.error(`重建失败：${String(err)}`))

    const thr = threshold ?? DEDUP_THRESHOLD
    return c.json({
      msg: `Near-duplicate grouping started (threshold=${thr}${dryRun ? ', dry run' : ''}).`,
    }, 201)
  },
)

/**
 * SILVA：`SCORERS` 里每个蒸馏头共用这一段，只有 scorer 名不同。
 *
 * 已经有分就直接返回存的，不重算 —— 用户点这个按钮是想看分数，不是想烧 GPU。
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
    // 向量算不出来 = 这张图读不进来。报 400。（silva 的 payload 组装
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
      syncLog.info(`完成：新增 ${r.added}，删除 ${r.removed}`)
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
    if (!c.var.urlImports.start(url))
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
  c => c.json(c.var.urlImports.status(), 200),
)
