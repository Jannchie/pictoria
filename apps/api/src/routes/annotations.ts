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
  undoAnnotations,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, pyRepr, RESP_400, validationError, zodErrorHook } from '../openapi.js'
import { toIsoDateTime } from '../schemas.js'

/** 与 Python 侧 `annotations.py` 的常量一致。 */
const VALID_DIMENSIONS = ['color', 'finish', 'composition', 'overall'] as const
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
    post_id: z.int(),
    dimension: z.string(),
    scale: z.int(),
    value: z.int(),
    rubric_version: z.string(),
    session_id: z.string(),
    elapsed_ms: z.int().nullable().optional(),
  })
  .openapi('AbsoluteEventIn')

const AbsoluteBatchIn = z
  .object({
    events: z.array(AbsoluteEventIn),
    queue_id: z.int().nullable().optional(),
    queue_position: z.int().nullable().optional(),
  })
  .openapi('AbsoluteBatchIn')

const PairwiseEventIn = z
  .object({
    post_a: z.int(),
    post_b: z.int(),
    dimension: z.string(),
    winner: z.string(),
    rubric_version: z.string(),
    session_id: z.string(),
    elapsed_ms: z.int().nullable().optional(),
    queue_id: z.int().nullable().optional(),
    queue_position: z.int().nullable().optional(),
  })
  .openapi('PairwiseEventIn')

const ListwiseEventIn = z
  .object({
    post_ids: z.array(z.int()),
    ranking: z.array(z.int()),
    dimension: z.string(),
    rubric_version: z.string(),
    session_id: z.string(),
    elapsed_ms: z.int().nullable().optional(),
    queue_id: z.int().nullable().optional(),
    queue_position: z.int().nullable().optional(),
  })
  .openapi('ListwiseEventIn')

const ContentFlagIn = z
  .object({ post_id: z.int(), flag: z.string(), session_id: z.string() })
  .openapi('ContentFlagIn')

const UndoIn = z
  .object({
    kind: z.string(),
    ids: z.array(z.int()),
    session_id: z.string(),
    queue_id: z.int().nullable().optional(),
    queue_position: z.int().nullable().optional(),
  })
  .openapi('UndoIn')

const EditIn = z.object({ verdict: z.union([z.int(), z.string()]) }).openapi('EditIn')

const AbsoluteAnnotationPublic = z
  .object({
    id: z.int(),
    createdAt: z.iso.datetime(),
    postId: z.int(),
    dimension: z.string(),
    scale: z.int(),
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
    dimension: z.string(),
    winner: z.string(),
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
    contentFlag: z.string().nullable().optional(),
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: InsertedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    for (const e of data.events) {
      if (!VALID_DIMENSIONS.includes(e.dimension as never))
        return validationError(`invalid dimension: '${e.dimension}'`) as never
      if (![2, 3, 5].includes(e.scale))
        return validationError(`invalid scale: ${e.scale}`) as never
      if (e.value < 1 || e.value > e.scale)
        return validationError(`value ${e.value} out of range for scale ${e.scale}`) as never
    }
    const { sqlite } = getDb()
    const ids = data.events.map((e: any) => insertAbsolute(sqlite, e))
    if (data.queue_id != null && data.queue_position != null)
      markQueueItemDone(sqlite, data.queue_id, { kind: 'absolute', position: data.queue_position })
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: InsertedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    if (!VALID_DIMENSIONS.includes(data.dimension as never))
      return validationError(`invalid dimension: '${data.dimension}'`) as never
    if (!VALID_WINNERS.includes(data.winner as never))
      return validationError(`invalid winner: '${data.winner}'`) as never
    const { sqlite } = getDb()
    const rowId = insertPairwise(sqlite, data)
    if (data.queue_id != null && data.queue_position != null)
      markQueueItemDone(sqlite, data.queue_id, { kind: 'pairwise', position: data.queue_position })
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: InsertedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    if (!VALID_DIMENSIONS.includes(data.dimension as never))
      return validationError(`invalid dimension: '${data.dimension}'`) as never
    if (data.post_ids.length < 2 || new Set(data.post_ids).size !== data.post_ids.length)
      return validationError(`post_ids must be >=2 distinct ids, got ${pyRepr(data.post_ids)}`) as never
    // 排序必须是这组成员的一个排列 —— 少一张、多一张、排到别的组的图，都是客户端 bug，
    // 拦在这里比拦在训练导出里便宜四个数量级。空数组 = skip，合法。
    const sameMembers = data.ranking.length === data.post_ids.length
      && new Set(data.ranking).size === data.ranking.length
      && data.ranking.every((pid: number) => data.post_ids.includes(pid))
    if (data.ranking.length && !sameMembers)
      return validationError(`ranking must be a permutation of post_ids (or [] to skip)`) as never
    const { sqlite } = getDb()
    const rowId = insertListwise(sqlite, data)
    if (data.queue_id != null && data.queue_position != null)
      markQueueItemDone(sqlite, data.queue_id, { kind: 'listwise', position: data.queue_position })
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: InsertedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    if (!VALID_FLAGS.includes(data.flag as never))
      return validationError(`invalid flag: '${data.flag}'`) as never
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
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    if (!MUTABLE_KINDS.has(data.kind))
      return validationError(`invalid kind: '${data.kind}'`) as never
    const { sqlite } = getDb()
    const deleted = undoAnnotations(sqlite, { kind: data.kind, ids: data.ids, sessionId: data.session_id })
    // 空 ids 是合法的：被跳过的队列项不写事件就标记完成，它的 undo 就只是取消标记。
    if (data.queue_id != null && data.queue_position != null)
      markQueueItemDone(sqlite, data.queue_id, { kind: data.kind, position: data.queue_position, done: false })
    return c.json({ deleted })
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
        kind: z.string().openapi({ param: { name: 'kind', in: 'path', required: true } }),
        annotation_id: z.coerce.number().int()
          .openapi({ param: { name: 'annotation_id', in: 'path', required: true }, type: 'integer' }),
      }),
      body: { required: true, content: { 'application/json': { schema: EditIn } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: UpdatedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { kind, annotation_id: annotationId } = c.req.valid('param')
    const { verdict } = c.req.valid('json')
    if (!MUTABLE_KINDS.has(kind))
      return validationError(`invalid kind: '${kind}'`) as never
    if (kind === 'pairwise' && !VALID_WINNERS.includes(verdict as never))
      return validationError(`invalid winner: ${JSON.stringify(verdict)}`) as never
    if (kind === 'absolute' && !(typeof verdict === 'number' && Number.isInteger(verdict) && verdict >= 1))
      return validationError(`invalid value: ${JSON.stringify(verdict)}`) as never
    const changed = editAnnotation(getDb().sqlite, { kind, annotationId, verdict })
    return c.json({ updated: changed ? 1 : 0 })
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
        dimension: z.string().default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PairwiseCountPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { dimension } = c.req.valid('query')
    if (!VALID_DIMENSIONS.includes(dimension as never))
      return validationError(`invalid dimension: '${dimension}'`) as never
    return c.json(countPairwise(getDb().sqlite, dimension))
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
      ...RESP_400,
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
      contentFlag: !flag || flag.flag === 'none' ? null : (flag.flag as string),
    })
  },
)

const TIMELINE_MAX_LIMIT = 100
const CURSOR_PARTS = 3

const QueueItemPostPublic = z
  .object({
    id: z.int(),
    filePath: z.string(),
    fileName: z.string(),
    extension: z.string(),
    sha256: z.string(),
    width: z.int(),
    height: z.int(),
  })
  .openapi('QueueItemPostPublic')

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

function parseCursor(raw?: string | null): [string, string, number] | null {
  if (!raw)
    return null
  const parts = raw.split('|')
  if (parts.length !== CURSOR_PARTS || parts.some(p => !p) || !/^\d+$/.test(parts[2]!))
    return 'malformed' as never
  return [parts[0]!, parts[1]!, Number(parts[2])]
}

function toQueuePost(p: any) {
  return {
    id: p.post_id,
    filePath: p.file_path,
    fileName: p.file_name,
    extension: p.extension,
    sha256: p.sha256,
    width: p.width,
    height: p.height,
  }
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
      ...RESP_400,
    },
  }),
  (c) => {
    const { limit, before } = c.req.valid('query')
    const cursor = parseCursor(before)
    if ((cursor as unknown) === 'malformed')
      return validationError(`malformed cursor: '${before}'`) as never

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
        post: toQueuePost(posts.get(r.post)),
        postB: r.post_b ? toQueuePost(posts.get(r.post_b)) : null,
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
    })
  },
)

/** 与 Python 侧 `annotation_queues.py` 的常量一致。 */
const VALID_STRATEGIES = ['random', 'stratified'] as const
const VALID_PAIRWISE_STRATEGIES = ['random', 'similar', 'close'] as const

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
        // 直接写 z.array 会让它在 schema 层就被拒（"Expected array"），根本走不到
        // handler 里那句 `invalid strategy: 'bogus'`。统一收成数组。
        dimensions: z.union([z.string(), z.array(z.string())])
          .transform((v: string | string[]) => (Array.isArray(v) ? v : [v]))
          .openapi({ param: { name: 'dimensions', in: 'query', required: true }, type: 'array', items: { type: 'string' } }),
        strategy: z.string().default('random')
          .openapi({ param: { name: 'strategy', in: 'query', required: false } }),
        limit: z.coerce.number().int().default(10)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 10 }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(QueueItemPostPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { dimensions, strategy, limit } = c.req.valid('query')
    if (!dimensions.length || dimensions.some((d: string) => !VALID_DIMENSIONS.includes(d as never)))
      return validationError(`invalid dimensions: ${pyRepr(dimensions)}`) as never
    if (!VALID_STRATEGIES.includes(strategy as never))
      return validationError(`invalid strategy: ${pyRepr(strategy)}`) as never

    const { sqlite } = getDb()
    const ids = samplePostIds(sqlite, { count: limit, strategy, dimensions })
    if (!ids.length)
      return c.json([]) as never
    const byId = postsById(sqlite, ids)
    // 抽取顺序就是采样顺序，队列也按它服务 —— 所以从 `ids` 重建，而不是从
    // `IN (...)` 返回的行序。
    return c.json(ids.filter(pid => byId.has(pid)).map(pid => toQueuePost(byId.get(pid)))) as never
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
        strategy: z.string().default('close')
          .openapi({ param: { name: 'strategy', in: 'query', required: false } }),
        dimension: z.string().default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(SampledPairPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { limit, strategy, dimension } = c.req.valid('query')
    if (!VALID_PAIRWISE_STRATEGIES.includes(strategy as never))
      return validationError(`invalid strategy: ${pyRepr(strategy)}`) as never
    if (!VALID_DIMENSIONS.includes(dimension as never))
      return validationError(`invalid dimension: ${pyRepr(dimension)}`) as never

    const { sqlite } = getDb()
    const pairs = samplePairs(sqlite, { count: limit, strategy, dimension })
    if (!pairs.length)
      return c.json([]) as never
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
    return c.json(out) as never
  },
)

const SampledGroupPublic = z
  .object({ posts: z.array(QueueItemPostPublic) })
  .openapi('SampledGroupPublic')

annotationsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotations/sample-listwise',
    operationId: 'v2SampleListwise',
    summary: 'SampleListwise',
    description: 'Queue-less streaming: sample groups of ~size posts whose silva scores sit in one close window, visually spread. Ranking one group yields C(size,2) boundary comparisons.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().default(5)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 5 }),
        size: z.coerce.number().int().default(6)
          .openapi({ param: { name: 'size', in: 'query', required: false }, type: 'integer', default: 6 }),
        dimension: z.string().default('overall')
          .openapi({ param: { name: 'dimension', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(SampledGroupPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { limit, size, dimension } = c.req.valid('query')
    if (!VALID_DIMENSIONS.includes(dimension as never))
      return validationError(`invalid dimension: ${pyRepr(dimension)}`) as never
    if (size < 3 || size > 16)
      return validationError(`invalid size: ${size} (want 3..16)`) as never

    const { sqlite } = getDb()
    const groups = sampleGroups(sqlite, { count: limit, size, dimension })
    const byId = postsById(sqlite, groups.flat())
    return c.json(
      groups
        .map(g => ({ posts: g.filter(pid => byId.has(pid)).map(pid => toQueuePost(byId.get(pid)!)) }))
        .filter(g => g.posts.length >= 3),
    ) as never
  },
)
