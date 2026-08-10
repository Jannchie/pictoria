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
  embeddingTask,
  encodeVectorBlob,
  GPU_QUEUE,
  silvaTask,
  taggerTask,
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
  persistAutoTagsForPost,
  ratingToInt,
  upsertAestheticScores,
  upsertVectors,
  upsertWaifuScores,
} from '@pictoria/db'
import { Buffer } from 'node:buffer'
import { DEDUP_THRESHOLD, isRebuilding, rebuildGroups } from '../dedup.js'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, Result, toPostDetail } from '../schemas.js'
import { targetDir } from '../scheduler.js'
import { translateTag } from '../tag-i18n.js'
import { getTasks } from '../tasks.js'

export const commandsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

const postIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' })

/** `server/exceptions.py` 里 `DomainError` 统一的响应形状。 */
function domainError(detail: string, error: string, status: 404 | 400) {
  return new Response(JSON.stringify({ detail, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

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
    return { ok: false, response: domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) }
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
    return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404)
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
      return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never

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
