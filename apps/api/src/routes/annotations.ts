/**
 * `/v2/annotations` —— 提交、撤回、更正、按 post 查历史、pairwise 计数。
 *
 * 三个端点仍透传：`timeline` 要把事件流和 post 图片字段拼起来（另一个仓储的
 * `posts_by_id`），两个 `sample-*` 依赖 1058 行的采样图算法。它们各自值得单独一趟。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  countPairwise,
  editAnnotation,
  insertAbsolute,
  insertContentFlag,
  insertPairwise,
  latestContentFlag,
  listAbsoluteForPost,
  listPairwiseForPost,
  markQueueItemDone,
  MUTABLE_KINDS,
  undoAnnotations,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
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

/**
 * Litestar 的 `ValidationException` → 400。
 *
 * ⚠️ 形状和 **schema 校验失败**不同：手抛的 ValidationException 把消息直接放进
 * `detail` 且**没有 `extra`**，而 msgspec 的 schema 校验失败是
 * `{detail: "Validation failed for …", extra: [...]}`。同一个状态码，两种形状。
 */
function validationError(c: any, message: string) {
  return c.json({ status_code: 400, detail: message }, 400)
}

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
        return validationError(c, `invalid dimension: '${e.dimension}'`) as never
      if (![2, 3, 5].includes(e.scale))
        return validationError(c, `invalid scale: ${e.scale}`) as never
      if (e.value < 1 || e.value > e.scale)
        return validationError(c, `value ${e.value} out of range for scale ${e.scale}`) as never
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
      return validationError(c, `invalid dimension: '${data.dimension}'`) as never
    if (!VALID_WINNERS.includes(data.winner as never))
      return validationError(c, `invalid winner: '${data.winner}'`) as never
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
      return validationError(c, `invalid flag: '${data.flag}'`) as never
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
      return validationError(c, `invalid kind: '${data.kind}'`) as never
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
      return validationError(c, `invalid kind: '${kind}'`) as never
    if (kind === 'pairwise' && !VALID_WINNERS.includes(verdict as never))
      return validationError(c, `invalid winner: ${JSON.stringify(verdict)}`) as never
    if (kind === 'absolute' && !(typeof verdict === 'number' && Number.isInteger(verdict) && verdict >= 1))
      return validationError(c, `invalid value: ${JSON.stringify(verdict)}`) as never
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
      return validationError(c, `invalid dimension: '${dimension}'`) as never
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
