/**
 * `/v2/annotation-queues` —— 从显式列表建队列、列队列、取下一批。
 *
 * 两个 `generate-*` 仍透传：它们要先跑采样器（`_PairGraph`、并查集、多样性子集、
 * 重访池，约 700 行），那部分还在 Python 侧。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  createAbsoluteQueue,
  createPairwiseQueue,
  listQueues,
  nextAbsoluteItems,
  nextPairwiseItems,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'

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

const QueueCreatedPublic = z.object({ id: z.int() }).openapi('QueueCreatedPublic')

const QueueSummaryPublic = z
  .object({
    id: z.int(),
    name: z.string(),
    kind: z.string(),
    dimensions: z.array(z.string()),
    scale: z.int().nullable().optional(),
    total: z.int(),
    done: z.int(),
  })
  .openapi('QueueSummaryPublic')

const AbsoluteQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.string()),
    scale: z.int(),
    post_ids: z.array(z.int()),
  })
  .openapi('AbsoluteQueueCreate')

const PairwiseQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.string()),
    pairs: z.array(z.tuple([z.int(), z.int()])),
  })
  .openapi('PairwiseQueueCreate')

const AbsoluteQueueItemPublic = z
  .object({ position: z.int(), post: QueueItemPostPublic })
  .openapi('AbsoluteQueueItemPublic')

const PairwiseQueueItemPublic = z
  .object({ position: z.int(), postA: QueueItemPostPublic, postB: QueueItemPostPublic })
  .openapi('PairwiseQueueItemPublic')

export const annotationQueuesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/** 带前缀的图片列 → `QueueItemPostPublic`。 */
function toQueuePost(row: Record<string, any>, prefix = '') {
  return {
    id: row[`${prefix}post_id`],
    filePath: row[`${prefix}file_path`],
    fileName: row[`${prefix}file_name`],
    extension: row[`${prefix}extension`],
    sha256: row[`${prefix}sha256`],
    width: row[`${prefix}width`],
    height: row[`${prefix}height`],
  }
}

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/absolute',
    operationId: 'v2CreateAbsolute',
    summary: 'CreateAbsolute',
    description: 'Create an absolute-annotation queue from an ordered post-id list.',
    request: { body: { required: true, content: { 'application/json': { schema: AbsoluteQueueCreate } } } },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const id = createAbsoluteQueue(getDb().sqlite, {
      name: d.name,
      dimensions: d.dimensions,
      scale: d.scale,
      postIds: d.post_ids,
    })
    return c.json({ id }, 201)
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/pairwise',
    operationId: 'v2CreatePairwise',
    summary: 'CreatePairwise',
    description: 'Create a pairwise queue from an ordered (post_a, post_b) list.',
    request: { body: { required: true, content: { 'application/json': { schema: PairwiseQueueCreate } } } },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const id = createPairwiseQueue(getDb().sqlite, {
      name: d.name,
      dimensions: d.dimensions,
      pairs: d.pairs as Array<[number, number]>,
    })
    return c.json({ id }, 201)
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotation-queues',
    operationId: 'v2ListQueues',
    summary: 'ListQueues',
    responses: {
      // 没有 400 —— 这个端点没有任何参数，Litestar 就不会挂校验错误响应。
      200: { description: OK, content: { 'application/json': { schema: z.array(QueueSummaryPublic) } } },
    },
  }),
  c => c.json(
    listQueues(getDb().sqlite).map(({ queue, total, done }) => ({
      id: queue.id,
      name: queue.name,
      kind: queue.kind,
      // DB 里存的是 JSON 字符串，对外是数组。
      dimensions: JSON.parse(queue.dimensions) as string[],
      scale: queue.scale,
      total,
      done,
    })),
  ),
)

const queueIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'queue_id', in: 'path', required: true }, type: 'integer' })
const limitParam = z.coerce.number().int().default(20)
  .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 20 })

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotation-queues/{queue_id}/next-absolute',
    operationId: 'v2NextAbsolute',
    summary: 'NextAbsolute',
    request: {
      params: z.object({ queue_id: queueIdParam }),
      query: z.object({ limit: limitParam }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(AbsoluteQueueItemPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { queue_id: queueId } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    return c.json(
      nextAbsoluteItems(getDb().sqlite, queueId, limit).map((r: any) => ({
        position: r.position,
        post: toQueuePost(r),
      })),
    )
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotation-queues/{queue_id}/next-pairwise',
    operationId: 'v2NextPairwise',
    summary: 'NextPairwise',
    request: {
      params: z.object({ queue_id: queueIdParam }),
      query: z.object({ limit: limitParam }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PairwiseQueueItemPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { queue_id: queueId } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    return c.json(
      nextPairwiseItems(getDb().sqlite, queueId, limit).map((r: any) => ({
        position: r.position,
        postA: toQueuePost(r, 'a_'),
        postB: toQueuePost(r, 'b_'),
      })),
    )
  },
)
