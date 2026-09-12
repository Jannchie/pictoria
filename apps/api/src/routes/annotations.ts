/**
 * `/v2/annotations` —— 提交、撤回、更正、timeline、按 post 查历史、pairwise 计数，
 * 以及两个无队列的 `sample-*` 流式取样。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  countPairwise,
  editAnnotation,
  insertAbsolute,
  insertContentFlag,
  insertListwise,
  insertPairwise,
  latestContentFlag,
  listAbsoluteForPost,
  listPairwiseForPost,
  annotationTimeline,
  markQueueItemDone,
  MUTABLE_KINDS,
  postsById,
  sampleGroups,
  samplePairs,
  samplePostIds,
  scorerValuesFor,
  SILVA,
  undoAnnotations,
} from '@pictoria/db'
import { expandListwiseAnnotations } from '@pictoria/db'
import { getDb } from '../db.js'
import { CREATED, OK, errors, invalidRequest, validationError, zodErrorHook } from '../openapi.js'
import { toIsoDateTime } from '../schemas.js'
import {
  QueueItemPostPublic,
  toQueuePost,
  VALID_DIMENSIONS,
  VALID_PAIRWISE_STRATEGIES,
  ScaleSchema,
  VALID_STRATEGIES,
} from './annotation-shared.js'

const VALID_WINNERS = ['a', 'b', 'tie', 'skip'] as const
const VALID_FLAGS = ['love', 'hate', 'none'] as const

const InsertedPublic = z.object({ inserted: z.int(), ids: z.array(z.int()) }).openapi('InsertedPublic')
const DeletedPublic = z.object({ deleted: z.int() }).openapi('DeletedPublic')
const UpdatedPublic = z.object({ updated: z.int() }).openapi('UpdatedPublic')

const PairwiseCountPublic = z
  .object({ total: z.int(), decisive: z.int(), tie: z.int(), skip: z.int() })
  .openapi('PairwiseCountPublic')

const AbsoluteEventIn = z
  .object({
    postId: z.int(),
    dimension: z.enum(VALID_DIMENSIONS),
    scale: ScaleSchema,
    value: z.int().min(1),
    rubricVersion: z.string(),
    sessionId: z.string(),
    elapsedMs: z.int().nullable().optional(),
  })
  .openapi('AbsoluteEventIn')

const AbsoluteBatchIn = z
  .object({
    events: z.array(AbsoluteEventIn),
    queueId: z.int().nullable().optional(),
    queuePosition: z.int().nullable().optional(),
  })
  .openapi('AbsoluteBatchIn')

const PairwiseEventIn = z
  .object({
    postA: z.int(),
    postB: z.int(),
    dimension: z.enum(VALID_DIMENSIONS),
    winner: z.enum(VALID_WINNERS),
    rubricVersion: z.string(),
    sessionId: z.string(),
    elapsedMs: z.int().nullable().optional(),
    queueId: z.int().nullable().optional(),
    queuePosition: z.int().nullable().optional(),
    /** 采样来源，决定这条比较能否用作留出评估。省略 = 未知。 */
    strategy: z.enum(VALID_PAIRWISE_STRATEGIES).nullable().optional(),
  })
  .openapi('PairwiseEventIn')

const ListwiseEventIn = z
  .object({
    postIds: z.array(z.int()).min(2),
    ranking: z.array(z.int()),
    dimension: z.enum(VALID_DIMENSIONS),
    rubricVersion: z.string(),
    sessionId: z.string(),
    elapsedMs: z.int().nullable().optional(),
    queueId: z.int().nullable().optional(),
    queuePosition: z.int().nullable().optional(),
  })
  .openapi('ListwiseEventIn')

const ContentFlagIn = z
  .object({ postId: z.int(), flag: z.enum(VALID_FLAGS), sessionId: z.string() })
  .openapi('ContentFlagIn')

const UndoIn = z
  .object({
    kind: z.enum(MUTABLE_KINDS),
    ids: z.array(z.int()),
    sessionId: z.string(),
    queueId: z.int().nullable().optional(),
    queuePosition: z.int().nullable().optional(),
  })
  .openapi('UndoIn')

const EditIn = z.object({ verdict: z.union([z.int(), z.string()]) }).openapi('EditIn')

const AbsoluteAnnotationPublic = z
  .object({
    id: z.int(),
    createdAt: z.iso.datetime(),
    postId: z.int(),
    dimension: z.enum(VALID_DIMENSIONS),
    scale: ScaleSchema,
    value: z.int(),
    rubricVersion: z.string(),
    sessionId: z.string(),
    elapsedMs: z.int().nullable().optional(),
    editedAt: z.iso.datetime().nullable().optional(),
  })
  .openapi('AbsoluteAnnotationPublic')

const PairwiseAnnotationPublic = z
  .object({
    id: z.int(),
    createdAt: z.iso.datetime(),
    postA: z.int(),
    postB: z.int(),
    dimension: z.enum(VALID_DIMENSIONS),
    winner: z.enum(VALID_WINNERS),
    rubricVersion: z.string(),
    sessionId: z.string(),
    elapsedMs: z.int().nullable().optional(),
    editedAt: z.iso.datetime().nullable().optional(),
  })
  .openapi('PairwiseAnnotationPublic')

const PostAnnotationsPublic = z
  .object({
    absolute: z.array(AbsoluteAnnotationPublic),
    pairwise: z.array(PairwiseAnnotationPublic),
    contentFlag: z.enum(['love', 'hate']).nullable().optional(),
  })
  .openapi('PostAnnotationsPublic')

export const annotationsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

annotationsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotations/absolute',
    operationId: 'v2SubmitAbsolute',
    summary: 'SubmitAbsolute',
    description: 'Submit a batch of absolute annotation events (one image, several dimensions). Optionally marks a queue item done.',
    request: { body: { required: true, content: { 'application/json': { schema: AbsoluteBatchIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: InsertedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    for (const e of data.events) {
      if (e.value > e.scale)
        return validationError(`value ${e.value} out of range for scale ${e.scale}`)
    }
    const { sqlite } = getDb()
    const ids = data.events.map((e: any) => insertAbsolute(sqlite, e))
    if (data.queueId != null && data.queuePosition != null)
      markQueueItemDone(sqlite, data.queueId, { kind: 'absolute', position: data.queuePosition })
    return c.json({ inserted: ids.length, ids }, 201)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotations/pairwise',
    operationId: 'v2SubmitPairwise',
    summary: 'SubmitPairwise',
    description: 'Submit one pairwise judgement. Optionally marks a queue item done.',
    request: { body: { required: true, content: { 'application/json': { schema: PairwiseEventIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: InsertedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    const { sqlite } = getDb()
    const rowId = insertPairwise(sqlite, data)
    if (data.queueId != null && data.queuePosition != null)
      markQueueItemDone(sqlite, data.queueId, { kind: 'pairwise', position: data.queuePosition })
    return c.json({ inserted: 1, ids: [rowId] }, 201)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotations/listwise',
    operationId: 'v2SubmitListwise',
    summary: 'SubmitListwise',
    description: 'Submit one group ranking (best first; empty ranking = skip). Optionally marks a queue item done.',
    request: { body: { required: true, content: { 'application/json': { schema: ListwiseEventIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: InsertedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    if (new Set(data.postIds).size !== data.postIds.length)
      return validationError(`postIds must be distinct, got ${JSON.stringify(data.postIds)}`)
    // 排序必须是这组成员的一个排列 —— 少一张、多一张、排到别的组的图，都是客户端 bug，
    // 拦在这里比拦在训练导出里便宜四个数量级。空数组 = skip，合法。
    const sameMembers = data.ranking.length === data.postIds.length
      && new Set(data.ranking).size === data.ranking.length
      && data.ranking.every((pid: number) => data.postIds.includes(pid))
    if (data.ranking.length && !sameMembers)
      return validationError('ranking must be a permutation of postIds (or [] to skip)')
    const { sqlite } = getDb()
    const rowId = insertListwise(sqlite, data)
    if (data.queueId != null && data.queuePosition != null)
      markQueueItemDone(sqlite, data.queueId, { kind: 'listwise', position: data.queuePosition })
    return c.json({ inserted: 1, ids: [rowId] }, 201)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotations/content-flag',
    operationId: 'v2SubmitContentFlag',
    summary: 'SubmitContentFlag',
    description: "Record a content taste flag for a post ('none' = retract).",
    request: { body: { required: true, content: { 'application/json': { schema: ContentFlagIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: InsertedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    return c.json({ inserted: 1, ids: [insertContentFlag(getDb().sqlite, data)] }, 201)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotations/undo',
    operationId: 'v2UndoAnnotations',
    summary: 'UndoAnnotations',
    description: 'Retract annotation events this session just submitted (a mis-click). Deletes the rows outright rather than flagging them, so they never reach training exports or the sampler\'s comparison graph. Only events whose session_id matches are touched. Also re-opens the queue item, if one was given.',
    request: { body: { required: true, content: { 'application/json': { schema: UndoIn } } } },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: DeletedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    const { sqlite } = getDb()
    const deleted = undoAnnotations(sqlite, { kind: data.kind, ids: data.ids, sessionId: data.sessionId })
    // 空 ids 是合法的：被跳过的队列项不写事件就标记完成，它的 undo 就只是取消标记。
    if (data.queueId != null && data.queuePosition != null)
      markQueueItemDone(sqlite, data.queueId, { kind: data.kind, position: data.queuePosition, done: false })
    return c.json({ deleted }, 200)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/v2/annotations/{kind}/{annotation_id}',
    operationId: 'v2EditAnnotation',
    summary: 'EditAnnotation',
    description: "Correct one already-submitted verdict IN PLACE (kind = 'pairwise' | 'absolute'). Not an appended correction: pairwise exports one row per judgement with no latest-wins pass, so a second row would leave the wrong verdict in the training set. Stamps edited_at.",
    request: {
      params: z.object({
        kind: z.enum(MUTABLE_KINDS).openapi({ param: { name: 'kind', in: 'path', required: true } }),
        annotation_id: z.coerce.number().int()
          .openapi({ param: { name: 'annotation_id', in: 'path', required: true }, type: 'integer' }),
      }),
      body: { required: true, content: { 'application/json': { schema: EditIn } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: UpdatedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { kind, annotation_id: annotationId } = c.req.valid('param')
    const { verdict } = c.req.valid('json')
    if (kind === 'pairwise' && !VALID_WINNERS.includes(verdict as never))
      return validationError(`invalid winner: ${JSON.stringify(verdict)}`)
    if (kind === 'absolute' && !(typeof verdict === 'number' && Number.isInteger(verdict) && verdict >= 1))
      return validationError(`invalid value: ${JSON.stringify(verdict)}`)
    const changed = editAnnotation(getDb().sqlite, { kind, annotationId, verdict })
    return c.json({ updated: changed ? 1 : 0 }, 200)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/pairwise/count',
    operationId: 'v2CountPairwise',
    summary: 'CountPairwise',
    description: 'Cumulative pairwise judgement counts for a dimension (total = decisive + tie, skips excluded).',
    request: {
      query: z.object({
        dimension: z.enum(VALID_DIMENSIONS).default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PairwiseCountPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { dimension } = c.req.valid('query')
    return c.json(countPairwise(getDb().sqlite, dimension), 200)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/post/{post_id}',
    operationId: 'v2PostHistory',
    summary: 'PostHistory',
    description: 'Full annotation history for a post.',
    request: {
      params: z.object({
        post_id: z.coerce.number().int()
          .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostAnnotationsPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { sqlite } = getDb()
    const flag = latestContentFlag(sqlite, postId)
    return c.json({
      absolute: listAbsoluteForPost(sqlite, postId).map((a: any) => ({
        id: a.id,
        createdAt: toIsoDateTime(a.created_at),
        postId: a.post_id,
        dimension: a.dimension,
        scale: a.scale,
        value: a.value,
        rubricVersion: a.rubric_version,
        sessionId: a.session_id,
        elapsedMs: a.elapsed_ms,
        editedAt: toIsoDateTime(a.edited_at),
      })),
      pairwise: listPairwiseForPost(sqlite, postId).map((p: any) => ({
        id: p.id,
        createdAt: toIsoDateTime(p.created_at),
        postA: p.post_a,
        postB: p.post_b,
        dimension: p.dimension,
        winner: p.winner,
        rubricVersion: p.rubric_version,
        sessionId: p.session_id,
        elapsedMs: p.elapsed_ms,
        editedAt: toIsoDateTime(p.edited_at),
      })),
      // 'none' 是撤回，对外等同于"没有 flag"。
      contentFlag: !flag || flag.flag === 'none' ? null : (flag.flag as 'love' | 'hate'),
    }, 200)
  },
)

const TIMELINE_MAX_LIMIT = 100
const CURSOR_PARTS = 3

const TimelineEntryPublic = z
  .object({
    kind: z.string(),
    id: z.int(),
    createdAt: z.iso.datetime(),
    post: QueueItemPostPublic,
    postB: z.union([QueueItemPostPublic, z.null()]).optional(),
    dimension: z.string().nullable().optional(),
    winner: z.string().nullable().optional(),
    scale: z.int().nullable().optional(),
    value: z.int().nullable().optional(),
    flag: z.string().nullable().optional(),
    /** listwise：post_id JSON 数组（最好在前；`[]` = skip）。post 是其中的赢家。 */
    ranking: z.string().nullable().optional(),
    editedAt: z.iso.datetime().nullable().optional(),
  })
  .openapi('TimelineEntryPublic')

const TimelinePagePublic = z
  .object({ items: z.array(TimelineEntryPublic), nextCursor: z.string().nullable().optional() })
  .openapi('TimelinePagePublic')

/**
 * `created_at|kind|id` —— 把合并流的全序压成一个不透明 token。
 *
 * 对客户端刻意不透明：它是一个**排序位置**而不是行 id，把三段都编进去，下一页才能
 * 精确地从这一页停下的地方续上（id 只在单表内递增）。
 *
 * **只为一页的最后一条原始行生成**，绝不逐条生成：post 已被删的行会从 items 里剔掉，
 * 所以最后一条可见条目不是这页停下的位置，从它续会把被剔掉的重新发一遍。
 */
function makeCursor(row: any): string {
  return `${row.created_at}|${row.kind}|${row.id}`
}

function parseCursor(raw?: string | null): [string, string, number] | 'malformed' | null {
  if (!raw)
    return null
  const parts = raw.split('|')
  if (parts.length !== CURSOR_PARTS || parts.some(p => !p) || !/^\d+$/.test(parts[2]!))
    return 'malformed'
  return [parts[0]!, parts[1]!, Number(parts[2])]
}

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/timeline',
    operationId: 'v2AnnotationTimeline',
    summary: 'AnnotationTimeline',
    description: "Everything submitted so far, newest first, across all three event kinds. Cursor-paged: pass the previous page's nextCursor as 'before'. Cursor rather than offset because the head of this list grows while it is being scrolled.",
    request: {
      query: z.object({
        limit: z.coerce.number().int().default(30)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 30 }),
        before: z.string().nullable().optional()
          .openapi({ param: { name: 'before', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: TimelinePagePublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { limit, before } = c.req.valid('query')
    const cursor = parseCursor(before)
    if (cursor === 'malformed')
      return validationError(`malformed cursor: ${JSON.stringify(before)}`)

    const page = Math.min(Math.max(limit, 1), TIMELINE_MAX_LIMIT)
    const { sqlite } = getDb()
    const rows = annotationTimeline(sqlite, { limit: page, before: cursor })
    const posts = postsById(sqlite, rows.flatMap((r: any) => [r.post, r.post_b].filter(Boolean)))

    const items = rows
      // 判决之后 post 被删了，这条事件就没东西可展示。在这里剔掉比渲染一个碎块诚实。
      .filter((r: any) => posts.has(r.post) && (!r.post_b || posts.has(r.post_b)))
      .map((r: any) => ({
        kind: r.kind,
        id: r.id,
        createdAt: toIsoDateTime(r.created_at),
        post: toQueuePost(posts.get(r.post)!),
        postB: r.post_b ? toQueuePost(posts.get(r.post_b)!) : null,
        dimension: r.dimension,
        winner: r.winner,
        scale: r.scale,
        value: r.value,
        flag: r.flag,
        ranking: r.ranking ?? null,
        editedAt: toIsoDateTime(r.edited_at),
      }))

    return c.json({
      items,
      nextCursor: rows.length === page ? makeCursor(rows[rows.length - 1]) : null,
    }, 200)
  },
)

const SampledPairPublic = z
  .object({ postA: QueueItemPostPublic, postB: QueueItemPostPublic })
  .openapi('SampledPairPublic')

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/sample-absolute',
    operationId: 'v2SampleAbsolute',
    summary: 'SampleAbsolute',
    description: 'Queue-less streaming: sample candidate posts for absolute annotation. Posts already annotated in any requested dimension are excluded.',
    request: {
      query: z.object({
        // ⚠️ 单个 `?dimensions=overall` 到 Hono 手里是**字符串**而不是长度 1 的数组，
        // 直接写 z.array 会让它在 schema 层就被拒（"Expected array"）。统一收成数组。
        dimensions: z.union([z.enum(VALID_DIMENSIONS), z.array(z.enum(VALID_DIMENSIONS)).min(1)])
          .transform(v => (Array.isArray(v) ? v : [v]))
          .openapi({ param: { name: 'dimensions', in: 'query', required: true }, type: 'array', items: { type: 'string', enum: [...VALID_DIMENSIONS] } }),
        strategy: z.enum(VALID_STRATEGIES).default('random')
          .openapi({ param: { name: 'strategy', in: 'query', required: false } }),
        limit: z.coerce.number().int().default(10)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 10 }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(QueueItemPostPublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { dimensions, strategy, limit } = c.req.valid('query')
    const { sqlite } = getDb()
    const ids = samplePostIds(sqlite, { count: limit, strategy, dimensions })
    if (!ids.length)
      return c.json([], 200)
    const byId = postsById(sqlite, ids)
    // 抽取顺序就是采样顺序，队列也按它服务 —— 所以从 `ids` 重建，而不是从
    // `IN (...)` 返回的行序。
    return c.json(ids.filter(pid => byId.has(pid)).map(pid => toQueuePost(byId.get(pid)!)), 200)
  },
)

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/sample-pairwise',
    operationId: 'v2SamplePairwise',
    summary: 'SamplePairwise',
    description: 'Queue-less streaming: sample pairs for pairwise annotation. \'close\' (default) = visually similar and hard for the model, extending the comparison graph already collected for this dimension; \'similar\' = model-agnostic content-similar + old-score band; \'random\' = uniform.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().default(10)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 10 }),
        strategy: z.enum(VALID_PAIRWISE_STRATEGIES).default('close')
          .openapi({ param: { name: 'strategy', in: 'query', required: false } }),
        dimension: z.enum(VALID_DIMENSIONS).default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(SampledPairPublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { limit, strategy, dimension } = c.req.valid('query')
    const { sqlite } = getDb()
    const pairs = samplePairs(sqlite, { count: limit, strategy, dimension })
    if (!pairs.length)
      return c.json([], 200)
    // 整批一次取图，然后在 JS 里拼对。对的**顺序**是吃重的
    // （interleaveWithBridges 保证每个前缀都连通），所以从 `pairs` 重建。
    const byId = postsById(sqlite, pairs.flat())
    const out = []
    for (const [a, b] of pairs) {
      const rowA = byId.get(a)
      const rowB = byId.get(b)
      if (!rowA || !rowB)
        continue // 采样和取图之间 post 被删了
      out.push({ postA: toQueuePost(rowA), postB: toQueuePost(rowB) })
    }
    return c.json(out, 200)
  },
)

/**
 * `silva` 与 `posts` 同序，是标注端把「模型学到的顺序如何」直接量出来的原料：客户端
 * 拿自己的排序和它算成对一致率。**呈现顺序仍然是随机的**（sampleGroups 返回前 shuffle），
 * 分数只在提交后参与统计、不进入呈现 —— 一旦按 silva 排列或把分数显示在图上，那 8.6%
 * 由位置惰性决定的边界判决就会系统性倒向模型，而 post_ids 里的呈现序也就再也审计不出
 * 顺序效应（两者共线）。
 *
 * 缺分为 null：采样器只收有 silva 分的图（ANCHORED_ELIGIBLE），所以实际不会出现，
 * 留着是因为 `0` 会被下游当成「最差」而不是「不知道」。
 */
const SampledGroupPublic = z
  .object({ posts: z.array(QueueItemPostPublic), silva: z.array(z.number().nullable()) })
  .openapi('SampledGroupPublic')

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/sample-listwise',
    operationId: 'v2SampleListwise',
    summary: 'SampleListwise',
    description: 'Queue-less streaming: sample groups of ~size posts whose silva scores sit in one close window, visually spread. Ranking one group yields C(size,2) boundary comparisons — worth Sum_{k=2..size}(1-1/k) in Plackett-Luce information, not C(size,2) independent observations.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().default(5)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 5 }),
        size: z.coerce.number().int().min(3).max(16).default(4)
          .openapi({ param: { name: 'size', in: 'query', required: false }, type: 'integer', default: 4 }),
        dimension: z.enum(VALID_DIMENSIONS).default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
        // 一批里有多大比例是**重排的老组**（>= REPEAT_MIN_AGE_DAYS 天前排过、只排过一次、
        // 成员重新打乱）。省略时走 REPEAT_SHARE 这条常年的工时税；传 1 就是一次专门的
        // 自一致率测量会话 —— 那个数是判断「模型在边界上的 0.60 是没学会还是标签本来就
        // 吵」的唯一标尺，而两种情况下该做的事正好相反。
        repeat: z.coerce.number().min(0).max(1).optional()
          .openapi({ param: { name: 'repeat', in: 'query', required: false }, type: 'number' }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(SampledGroupPublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { limit, size, dimension, repeat } = c.req.valid('query')
    const { sqlite } = getDb()
    const groups = sampleGroups(sqlite, { count: limit, size, dimension, repeatShare: repeat })
    const flat = groups.flat()
    const byId = postsById(sqlite, flat)
    const silvaById = scorerValuesFor(sqlite, flat, SILVA.name)
    return c.json(
      groups
        .map((g) => {
          const ids = g.filter(pid => byId.has(pid))
          return { posts: ids.map(pid => toQueuePost(byId.get(pid)!)), silva: ids.map(pid => silvaById.get(pid) ?? null) }
        })
        .filter(g => g.posts.length >= 3),
      200,
    )
  },
)


/**
 * 训练用的 listwise 导出：每条人工排序，加上把其中的图换成同组差分后的变体。
 *
 * 依据是标注行为本身 —— 同一差分组内的成对判决 94% 是平局（跨组只有 22%），而且
 * 决策快一倍。人把它们当可互换的，那么换掉排序里的一张图，人给出的名次不该变。
 *
 * 输出 JSONL（一行一条），而不是一个 JSON 数组：这份东西是拿去喂训练脚本的，流式
 * 读一行解析一行比先把几千条载进内存自然。
 *
 * ⚠️ 每行都带 `annotationId`，**划分数据集必须按它分组**。同一条标注展开出的变体
 * 共享同一个人类判决，信息量仍然是一条；让它们分落训练与验证两侧，验证指标就变成了
 * 在考模型有没有背过这张图。
 */
const ExportQuery = z.object({
  max_candidates_per_slot: z.coerce.number().int().min(1).max(8).default(3)
    .openapi({ param: { name: 'max_candidates_per_slot', in: 'query', required: false } }),
  max_variants_per_annotation: z.coerce.number().int().min(1).max(64).default(8)
    .openapi({ param: { name: 'max_variants_per_annotation', in: 'query', required: false } }),
  max_lpips: z.coerce.number().nullable().optional()
    .openapi({ param: { name: 'max_lpips', in: 'query', required: false }, type: ['number', 'null'] }),
})

// 文档和路由分开注册：zod-openapi 只给 JSON 和 text/plain 的 content 推得出返回
// 类型，`application/x-ndjson` 会把 200 这一支推成 never，`.openapi()` 的 handler
// 就没有任何合法返回值。查询参数的校验在 handler 里用同一个 schema 手动跑一遍。
annotationsRoutes.openAPIRegistry.registerPath({
  method: 'get',
  path: '/v2/annotations/listwise/export',
  tags: ['Annotations'],
  operationId: 'v2ExportListwise',
  summary: 'ExportListwise',
  description:
    'Listwise annotations expanded through variant groups, as JSONL. '
    + 'Every line carries annotationId; split datasets by it, never by row.',
  request: { query: ExportQuery },
  responses: {
    200: { description: OK, content: { 'application/x-ndjson': { schema: z.string() } } },
    ...errors(400),
  },
})

annotationsRoutes.get('/v2/annotations/listwise/export', (c) => {
  const parsed = ExportQuery.safeParse(c.req.query())
  if (!parsed.success)
    return invalidRequest(c, parsed.error)
  const q = parsed.data
  const rows = expandListwiseAnnotations(getDb().sqlite, {
    maxCandidatesPerSlot: q.max_candidates_per_slot,
    maxVariantsPerAnnotation: q.max_variants_per_annotation,
    ...(q.max_lpips == null ? {} : { maxLpips: q.max_lpips }),
  })
  return c.body(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': 'attachment; filename="listwise-expanded.jsonl"',
  })
})
