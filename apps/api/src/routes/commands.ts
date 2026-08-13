/**
 * `/v2/cmd/*` —— 命令式端点：它们不是资源的 CRUD，而是"去做一件事"。
 *
 * 这一组是迁移里最后动的，因为每一个背后都拴着一段 Python 计算。走到这里的前提是
 * cairnq 已经把计算和落库分开（§D1）：端点只负责挑活、提交、把结果写回，具体算什么
 * 在 Python worker 那边。
 */
import type { CairnQ } from 'cairnq'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  captionTask,
  DANBOORU_LISTING_LIMIT,
  danbooruImportTask,
  embeddingTask,
  encodeVectorBlob,
  GPU_QUEUE,
  IO_QUEUE,
  silvaTask,
  taggerTask,
  urlDownloadTask,
  urlScanTask,
  waifuTask,
} from '@pictoria/contracts'
import {
  ensureCanonicalTagGroups,
  fetchEmbeddingBlobs,
  getAestheticScore,
  getDetail,
  getPostPath,
  getWaifuScore,
  isImagePath,
  listImportedDanbooruIds,
  persistPostsWithTags,
  persistAutoTagsForPost,
  ratingToInt,
  upsertAestheticScores,
  updateField,
  upsertVectors,
  upsertWaifuScores,
} from '@pictoria/db'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEDUP_THRESHOLD, isRebuilding, rebuildGroups } from '../dedup.js'
import { getDb } from '../db.js'
import { OK, RESP_400, domainError, postNotFound, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, Result, toPostDetail } from '../schemas.js'
import { wakeAllBackfills } from '../scheduler.js'
import { targetDir } from '../paths.js'
import { startSync } from '../sync.js'
import { translateTag } from '../tag-i18n.js'
import { getTasks } from '../tasks.js'

const SnapshotResult = z.object({ path: z.string(), dir: z.string() }).openapi('SnapshotResult')

const DanbooruDownloadStats = z
  .object({
    total: z.int(),
    with_url: z.int(),
    filtered: z.int(),
    downloaded: z.int(),
    skipped: z.int(),
    failed: z.int(),
    early_stopped: z.boolean(),
  })
  .openapi('DanbooruDownloadStats')

export const commandsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

const postIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' })

/**
 * 即时命令共用的两道守卫：post 不存在 → 404，不是图片 → 400。
 *
 * 顺序照抄 Python：先查存在再判类型，所以一个不存在的 id 永远是 404 而不是 400。
 */
function requireImage(postId: number):
  | { ok: true, path: string }
  | { ok: false, response: Response } {
  const post = getPostPath(getDb().sqlite, postId)
  if (!post)
    return { ok: false, response: postNotFound(postId) }
  if (!isImagePath(post.fullPath))
    return { ok: false, response: domainError(`Post ${postId} is not an image.`, 'NotAnImageError', 400) }
  return { ok: true, path: `${targetDir()}/${post.fullPath}` }
}

/**
 * 一张图的即时任务共用的提交参数。
 *
 * `conflict: 'reuse'` + 带 id 的 key：用户连点两下拿回的是同一个任务，而不是
 * 两次 GPU 计算。`maxAttempts: 1` —— 有人在等这个响应，重试只会让他多等一轮。
 */
function oneShot(key: string) {
  return { queue: GPU_QUEUE, key, conflict: 'reuse', waitTimeoutMs: 300_000, maxAttempts: 1 } as const
}

/** 回读详情。命令端点算完之后一律返回最新的 PostDetailPublic。 */
function detailResponse(postId: number) {
  const detail = getDetail(getDb().sqlite, postId, n => translateTag(n))
  if (!detail)
    return postNotFound(postId)
  return Response.json(toPostDetail(detail))
}

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
      }),
    },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: Result } } },
      ...RESP_400,
    },
  }),
  async (c) => {
    const { threshold } = c.req.valid('query')
    // ⚠️ 必须在忙检查**之前** await。检查和启动之间夹一个 await，两个几乎同时到达
    // 的请求就会双双通过检查，然后排成两次全量重算 —— 一次分钟级的 GPU 白烧。
    // 先把这个 await 做掉，检查和启动就都落在同一个同步片段里。
    const tasks = await getTasks()

    // 忙就报忙，不排队（和 Python 侧 `rebuild_lock.locked()` 同款判断）。
    if (isRebuilding())
      return c.json({ msg: 'Near-duplicate grouping already running' }, 201)

    const opts = threshold == null ? {} : { threshold }
    // fire-and-forget：请求立刻返回，结果打进日志。失败在这里吞掉并记下 ——
    // 没有人在等这个 promise，未处理的 rejection 会让整个进程退出。
    void rebuildGroups(getDb().sqlite, tasks, opts)
      .catch((err: unknown) => console.warn(`[dedup] 重建失败：${String(err)}`))

    const thr = threshold ?? DEDUP_THRESHOLD
    return c.json({ msg: `Near-duplicate grouping started (threshold=${thr}).` }, 201)
  },
)

/**
 * waifu 质量分：算一张、存一张、返回它。
 *
 * 已经有分就直接返回存的，不重算 —— 用户点这个按钮是想看分数，不是想烧 GPU。
 * 算完仍然没有分意味着 worker 没能把它当成图片读进来，照 Python 侧一样报 400
 * （"扩展名像图片"和"解码器能读"是两件事）。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/cmd/waifu-scorer/{post_id}',
    operationId: 'v2GetWaifuScorerOne',
    summary: 'GetWaifuScorerOne',
    description: 'Compute (and persist) the waifu score for a single post.\n\nDelegates the compute + persist to the backfill worker\'s batch function\n(single-element id list), the same path ``process_post`` uses, instead\nof re-inlining the lazy model load / upsert. The guards keep the HTTP\ncontract: missing post -> 404, non-image -> 400, already-scored ->\nreturn the stored score without recomputing.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.number() } } },
      ...RESP_400,
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const guard = requireImage(postId)
    if (!guard.ok)
      return guard.response as never

    const { sqlite } = getDb()
    const existing = getWaifuScore(sqlite, postId)
    if (existing !== null)
      return c.json(existing)

    const tasks: CairnQ = await getTasks()
    const result = await tasks.call(waifuTask, {
      items: [{ postId, path: guard.path }],
    }, oneShot(`waifu:one:${postId}`))
    upsertWaifuScores(sqlite, result.scores)

    const score = getWaifuScore(sqlite, postId)
    if (score === null)
      return domainError(`Post ${postId} is not an image.`, 'NotAnImageError', 400) as never
    return c.json(score)
  },
)

/**
 * SILVA / SILVA-Luna：两个蒸馏头共用这一段，只有 scorer 名不同。
 *
 * 输入是已存的 SigLIP2 向量。没有向量就**先算向量**再打分，这样用户点一次就能
 * 拿到结果，而不是"请稍后再试"。
 */
function silvaOneShot(scorer: 'silva' | 'silva_luna') {
  return async (c: any) => {
    const { post_id: postId } = c.req.valid('param') as { post_id: number }
    const guard = requireImage(postId)
    if (!guard.ok)
      return guard.response

    const { sqlite } = getDb()
    const existing = getAestheticScore(sqlite, postId, scorer)
    if (existing !== null)
      return c.json(existing)

    const tasks: CairnQ = await getTasks()
    let blobs = fetchEmbeddingBlobs(sqlite, [postId])
    if (!blobs.has(postId)) {
      const embedded = await tasks.call(embeddingTask, {
        items: [{ postId, path: guard.path }],
      }, oneShot(`embedding:one:${postId}`))
      upsertVectors(sqlite, embedded.embeddings.map(e => ({
        postId: e.postId,
        embedding: Buffer.from(e.embedding, 'base64'),
      })))
      blobs = fetchEmbeddingBlobs(sqlite, [postId])
    }
    // 向量算不出来 = 这张图读不进来。和 waifu 一样报 400。
    if (!blobs.has(postId))
      return domainError(`Post ${postId} is not an image.`, 'NotAnImageError', 400)

    const result = await tasks.call(silvaTask, {
      scorer,
      items: [{ postId, embedding: encodeVectorBlob(blobs.get(postId)!) }],
    }, oneShot(`${scorer}:one:${postId}`))
    upsertAestheticScores(sqlite, scorer, result.scores)

    const score = getAestheticScore(sqlite, postId, scorer)
    if (score === null)
      return domainError(`Post ${postId} is not an image.`, 'NotAnImageError', 400)
    return c.json(score)
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
      ...RESP_400,
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
      ...RESP_400,
    },
  }),
  silvaOneShot('silva_luna'),
)

/**
 * 自动标签：跑 WDTagger，标签和 rating 落库，返回最新详情。
 *
 * ⚠️ 这里**没有** `is_image` 守卫 —— Python 侧也没有，只查 post 存不存在。不是遗漏：
 * 少一道守卫会让一个非图片走到 worker 那里失败，而多一道会让今天能标注的某种
 * 扩展名突然 400。契约照抄，不"顺手修好"。
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
      ...RESP_400,
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { sqlite } = getDb()
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId) as never

    const tasks: CairnQ = await getTasks()
    const result = await tasks.call(taggerTask, {
      items: [{ postId, path: `${targetDir()}/${post.fullPath}` }],
    }, oneShot(`tagger:one:${postId}`))

    const row = result.results[0]
    // worker 把"读不出来"和"标签全空"都算失败。这里不能当成"标注完了但没标签"
    // 静默返回 200 —— 那会让前端以为标注成功而实际上一个字都没写。让它 500，
    // 和 Python 侧 tagger.tag 抛异常的结果一致。
    if (!row) {
      const why = result.failures[0]?.error ?? 'tagger returned no result'
      throw new Error(`auto-tags failed for post ${postId}: ${why}`)
    }
    persistAutoTagsForPost(sqlite, {
      postId,
      generalTags: row.generalTags,
      characterTags: row.characterTags,
      rating: ratingToInt(row.rating),
    }, ensureCanonicalTagGroups(sqlite))
    return detailResponse(postId) as never
  },
)

/**
 * 自动配文：跑 OpenAI，把结果写进 `posts.caption`，回读详情。
 *
 * 没配 key 时 Python 抛 `MissingConfigError`（400）。worker 把"没配"作为**数据**
 * 回传而不是抛异常 —— 那不是一次值得重试的失败，是一句该由 HTTP 层措辞的话。
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
      ...RESP_400,
    },
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { sqlite } = getDb()
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId) as never

    const tasks: CairnQ = await getTasks()
    const result = await tasks.call(captionTask, {
      imagePath: `${targetDir()}/${post.fullPath}`,
    }, { queue: IO_QUEUE, waitTimeoutMs: 120_000, pollMs: 20, maxAttempts: 1 })

    if (!result.configured)
      return domainError('OpenAI API key is not set.', 'MissingConfigError', 400) as never

    updateField(sqlite, postId, 'caption', result.caption)
    return detailResponse(postId) as never
  },
)

/**
 * 把在线库快照到一个临时文件，好让外部工具打开它。
 *
 * SQLite 的 `VACUUM INTO` 会产出一份自包含、一致的副本，写者活跃时也能做
 * （它内部走一个读事务）。调用方自己打开、查询、然后删掉那个目录。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/db/snapshot',
    operationId: 'v2DbSnapshot',
    summary: 'DbSnapshot',
    description: 'Create a point-in-time SQLite snapshot for offline tooling',
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: SnapshotResult } } },
    },
  }),
  (c) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-snapshot-'))
    const snapPath = path.join(tmpDir, 'snapshot.sqlite')
    // 路径由服务端生成（mkdtemp），不含单引号，所以直接内插是安全的 —— 和
    // Python 侧同样的理由。
    getDb().sqlite.exec(`VACUUM INTO '${snapPath.split(path.sep).join('/')}'`)
    console.warn(`[pictoria-api] 已生成快照 ${snapPath}`)
    return c.json({ path: snapPath, dir: tmpDir }, 201)
  },
)

/**
 * 重扫 target_dir 并把每个 backfill worker 都推一把。
 *
 * fire-and-forget：立刻返回，不让 HTTP 客户端干等一次几分钟的扫描。忙检查让
 * 连点这个按钮（或在上一次还没跑完时再点）成为空操作，而不是启动重复的活。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/sync-metadata',
    operationId: 'v2SyncMetadataEndpoint',
    summary: 'SyncMetadataEndpoint',
    description: 'Rescan target_dir and run every backfill worker',
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: Result } } },
    },
  }),
  (c) => {
    const started = startSync(getDb().sqlite, (r) => {
      console.warn(`[sync] 完成：新增 ${r.added}，删除 ${r.removed}`)
      // 新行的空列由 backfill 循环去填。Python 侧在这里同步跑完
      // run_all_backfill，这边只是把空转的循环叫醒 —— 同一批 worker，同样的活。
      wakeAllBackfills()
    })
    return c.json({ msg: started ? 'Sync started' : 'Sync already running' }, 201)
  },
)

/**
 * Windows 不允许文件名里出现 `<>:"/\|?*`；`re:rin` 这种 Danbooru 标签否则会
 * mkdir 失败。控制字符一并替换掉，尾部的点和空格也要削掉（Windows 不允许）。
 */
function safeDirName(name: string): string {
  let out = ''
  for (const ch of name)
    out += '<>:"/\\|?*'.includes(ch) || ch < ' ' ? '_' : ch
  return out.replace(/[.\s]+$/, '') || '_'
}

/**
 * 从 Danbooru 下载一个标签下的图并落库。
 *
 * 抓取和下载在 worker（那个客户端带着两道调好的限流闸和一个很微妙的翻页停止条件），
 * 落库在这里。两样东西必须随 payload 走，因为 worker 没有库可查：已导入的 post id
 * 集合（去重和停止条件都要它），以及 tag 类型 → 组 id 的映射。
 *
 * `full_scan` 会翻到列表尾部，用来捡起"我们导完它的 id 邻居之后 Danbooru 才打上
 * 这个标签"的那些 post；默认不开，因为那种情况少见而代价是每次都翻满。
 */
commandsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/cmd/download-from-danbooru',
    operationId: 'v2DownloadFromDanbooru',
    summary: 'DownloadFromDanbooru',
    description: 'Download posts from Danbooru',
    request: {
      query: z.object({
        tags: z.string().openapi({ param: { name: 'tags', in: 'query', required: true } }),
        full_scan: z.coerce.boolean().default(false)
          .openapi({ param: { name: 'full_scan', in: 'query', required: false }, type: 'boolean', default: false }),
      }),
    },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: DanbooruDownloadStats } } },
      ...RESP_400,
    },
  }),
  async (c) => {
    const { tags } = c.req.valid('query')
    // z.coerce.boolean() 把 "false" 当成 true，自己解析（同 rotate 的 clockwise）。
    const rawFullScan = c.req.query('full_scan')
    const fullScan = rawFullScan !== undefined && !/^(?:false|0)$/i.test(rawFullScan)

    const { sqlite } = getDb()
    const filePathStr = `danbooru/${safeDirName(tags)}`
    const saveDir = path.resolve(targetDir(), filePathStr)

    const tasks: CairnQ = await getTasks()
    const result = await tasks.call(danbooruImportTask, {
      tags,
      limit: DANBOORU_LISTING_LIMIT,
      fullScan,
      importedIds: listImportedDanbooruIds(sqlite, filePathStr),
      saveDir,
      filePathStr,
      typeToGroupId: ensureCanonicalTagGroups(sqlite),
    }, {
      queue: IO_QUEUE,
      // 一次大标签的列表 + 下载是分钟级的：CDN 被限到约 1 req/s。
      waitTimeoutMs: 60 * 60_000,
      pollMs: 200,
      maxAttempts: 1,
    })

    persistPostsWithTags(sqlite, result.rows)
    // 新行只有路径三元组，其余列等 backfill 去填 —— 别让它们干等一轮空转。
    wakeAllBackfills()
    return c.json(result.stats, 201)
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
    syncTriggered: z.boolean().default(false),
  })
  .openapi('UrlImportStatus')

/**
 * 当前 / 上一次 URL 导入的状态。
 *
 * 进程内的一个对象，和 Python 侧的 `app.state.url_import_status` 一一对应 ——
 * 不落库，重启即回到 idle。前端靠轮询它拿进度。
 */
let urlImportStatus: {
  state: 'idle' | 'running' | 'done' | 'failed'
  url: string | null
  stats: { fetched: number, images: number, new: number, downloaded: number, failed: number } | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  syncTriggered: boolean
} = {
  state: 'idle',
  url: null,
  stats: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  syncTriggered: false,
}

/** ISO，秒精度 —— 和 Python 的 `isoformat(timespec="seconds")` 同形。 */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/**
 * 后台跑一次 gallery-dl 导入。
 *
 * 三步，中间那步必须回到 TS：扫描（worker 跑 gallery-dl）→ **按目录去重**
 * （读库）→ 下载 + 落库。gallery-dl 是个 Python 工具，所以扫描和下载只能在
 * worker；去重是数据库读，所以只能在这里。
 */
async function runUrlImport(url: string): Promise<void> {
  const status = urlImportStatus
  try {
    await importOnce(url, status)
  }
  catch (err) {
    status.state = 'failed'
    status.error = String(err)
    status.finishedAt = nowIso()
    console.warn(`[url-import] ${url} 失败：${String(err)}`)
    return
  }
  status.state = 'done'
  status.finishedAt = nowIso()
  // 新图需要向量 / 分数 / 自动标签（kemono 的帖子根本不带标签）—— 踢一脚既有的
  // backfill 流程。⚠️ 必须在 state='done' **之后**，因为 done 是前端停止轮询的信号，
  // 而 syncTriggered 是它要读的最后一个字段。
  status.syncTriggered = startSync(getDb().sqlite, () => wakeAllBackfills())
}

/**
 * 一次导入的三步。
 *
 * 单独一个函数是为了让"没有可导的东西"能用 `return` 干净地退出，而不会顺带跳过
 * 外面那句 `state = 'done'` —— 第一版把两者写在一起，结果空结果的导入永远停在
 * `running`，前端会一直转圈。
 */
async function importOnce(url: string, status: typeof urlImportStatus): Promise<void> {
  const { sqlite } = getDb()
  const tasks: CairnQ = await getTasks()

  const scan = await tasks.call(urlScanTask, { url }, {
    queue: IO_QUEUE,
    waitTimeoutMs: 30 * 60_000,
    pollMs: 200,
    maxAttempts: 1,
  })
  status.stats = { fetched: scan.fetched, images: scan.items.length, new: 0, downloaded: 0, failed: 0 }
  if (!scan.items.length)
    return

  // 一个目录下已经有的 file_name。判据是"行存在"而不是"有手工标签" —— 和
  // Danbooru 那边不同，这里照抄 gallery_dl_import 的原样。
  const existing = new Set(
    sqlite
      .prepare<[string], { file_name: string }>('SELECT file_name FROM posts WHERE file_path = ?')
      .all(scan.filePath)
      .map(r => r.file_name),
  )
  const fresh = scan.items.filter((it: { fileName: string }) => !existing.has(it.fileName))
  status.stats.new = fresh.length
  if (!fresh.length)
    return

  const result = await tasks.call(urlDownloadTask, {
    items: fresh,
    saveDir: path.resolve(targetDir(), scan.filePath),
    filePathStr: scan.filePath,
    typeToGroupId: ensureCanonicalTagGroups(sqlite),
  }, {
    queue: IO_QUEUE,
    waitTimeoutMs: 60 * 60_000,
    pollMs: 200,
    maxAttempts: 1,
  })
  status.stats.downloaded = result.downloaded
  status.stats.failed = result.failed
  persistPostsWithTags(sqlite, result.rows)
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
        url: z.string().openapi({ param: { name: 'url', in: 'query', required: true } }),
      }),
    },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: Result } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { url } = c.req.valid('query')
    if (urlImportStatus.state === 'running')
      return c.json({ msg: 'Import already running' }, 201)

    // 同步换掉整个状态对象，于是"忙不忙"的判断在单线程事件循环上没有竞态。
    urlImportStatus = {
      state: 'running',
      url,
      stats: null,
      error: null,
      startedAt: nowIso(),
      finishedAt: null,
      syncTriggered: false,
    }
    void runUrlImport(url)
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
  c => c.json(urlImportStatus),
)
