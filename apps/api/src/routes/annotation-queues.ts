/**
 * `/v2/annotation-queues` —— 从显式列表建队列、列队列、取下一批。
 *
 * 两个 `generate-*` 先跑采样器（PairGraph、并查集、多样性子集、重访池，见
 * `@pictoria/db` 的 sampling.ts）再把抽出来的 id / 对写成一个队列。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  createAbsoluteQueue,
  createListwiseQueue,
  createPairwiseQueue,
  listQueues,
  MUTABLE_KINDS,
  nextAbsoluteItems,
  nextListwiseItems,
  nextPairwiseItems,
  postsById,
  sampleGroups,
  samplePairs,
  samplePostIds,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { CREATED, OK, errors, fail, zodErrorHook } from '../openapi.js'
import {
  QueueItemPostPublic,
  toQueuePost,
  VALID_DIMENSIONS,
  VALID_PAIRWISE_STRATEGIES,
  ScaleSchema,
  VALID_STRATEGIES,
} from './annotation-shared.js'

/** 采样器一个候选都挑不出来：请求合法，只是库的状态满足不了它。 */
function noCandidates(detail: string) {
  return fail(409, 'NoEligibleCandidatesError', detail)
}

const QueueCreatedPublic = z.object({ id: z.int() }).openapi('QueueCreatedPublic')

const QueueSummaryPublic = z
  .object({
    id: z.int(),
    name: z.string(),
    kind: z.enum(MUTABLE_KINDS),
    dimensions: z.array(z.enum(VALID_DIMENSIONS)),
    scale: ScaleSchema.nullable().optional(),
    total: z.int(),
    done: z.int(),
    /** pairwise 队列的采样策略；其余形态为 null。提交时前端带回到事件行。 */
    strategy: z.enum(VALID_PAIRWISE_STRATEGIES).nullable().optional(),
  })
  .openapi('QueueSummaryPublic')

type QueueSummary = z.infer<typeof QueueSummaryPublic>

const AbsoluteQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.enum(VALID_DIMENSIONS)).min(1),
    scale: ScaleSchema,
    postIds: z.array(z.int()),
  })
  .openapi('AbsoluteQueueCreate')

const PairwiseQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.enum(VALID_DIMENSIONS)).min(1),
    pairs: z.array(z.tuple([z.int(), z.int()])),
  })
  .openapi('PairwiseQueueCreate')

const ListwiseQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.enum(VALID_DIMENSIONS)).min(1),
    groups: z.array(z.array(z.int())),
  })
  .openapi('ListwiseQueueCreate')

const AbsoluteQueueItemPublic = z
  .object({ position: z.int(), post: QueueItemPostPublic })
  .openapi('AbsoluteQueueItemPublic')

const PairwiseQueueItemPublic = z
  .object({ position: z.int(), postA: QueueItemPostPublic, postB: QueueItemPostPublic })
  .openapi('PairwiseQueueItemPublic')

const ListwiseQueueItemPublic = z
  .object({ position: z.int(), posts: z.array(QueueItemPostPublic) })
  .openapi('ListwiseQueueItemPublic')

export const annotationQueuesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/absolute',
    operationId: 'v2CreateAbsolute',
    summary: 'CreateAbsolute',
    description: 'Create an absolute-annotation queue from an ordered post-id list.',
    request: { body: { required: true, content: { 'application/json': { schema: AbsoluteQueueCreate } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const id = createAbsoluteQueue(getDb().sqlite, {
      name: d.name,
      dimensions: d.dimensions,
      scale: d.scale,
      postIds: d.postIds,
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
      201: { description: CREATED, content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...errors(400),
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
    method: 'post',
    path: '/v2/annotation-queues/listwise',
    operationId: 'v2CreateListwise',
    summary: 'CreateListwise',
    description: 'Create a listwise queue from an ordered list of post-id groups.',
    request: { body: { required: true, content: { 'application/json': { schema: ListwiseQueueCreate } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...errors(400),
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const id = createListwiseQueue(getDb().sqlite, {
      name: d.name,
      dimensions: d.dimensions,
      groups: d.groups,
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
    description: 'List queues with progress, newest first.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(QueueSummaryPublic) } } },
    },
  }),
  c => c.json(
    // dimensions / scale / strategy 在写入时都经过了 enum 校验，读回来只需断言。
    listQueues(getDb().sqlite).map(({ queue, total, done }): QueueSummary => ({
      id: queue.id,
      name: queue.name,
      kind: queue.kind,
      dimensions: queue.dimensions as QueueSummary['dimensions'],
      scale: queue.scale as QueueSummary['scale'],
      total,
      done,
      strategy: queue.strategy as QueueSummary['strategy'],
    })),
    200,
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
    description: 'Next undone items of an absolute queue, with image info.',
    request: {
      params: z.object({ queue_id: queueIdParam }),
      query: z.object({ limit: limitParam }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(AbsoluteQueueItemPublic) } } },
      ...errors(400),
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
      200,
    )
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotation-queues/{queue_id}/next-pairwise',
    operationId: 'v2NextPairwise',
    summary: 'NextPairwise',
    description: 'Next undone items of a pairwise queue, with image info for both posts.',
    request: {
      params: z.object({ queue_id: queueIdParam }),
      query: z.object({ limit: limitParam }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PairwiseQueueItemPublic) } } },
      ...errors(400),
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
      200,
    )
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/annotation-queues/{queue_id}/next-listwise',
    operationId: 'v2NextListwise',
    summary: 'NextListwise',
    description: 'Next undone items of a listwise queue, each a group of posts to rank.',
    request: {
      params: z.object({ queue_id: queueIdParam }),
      query: z.object({ limit: limitParam }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(ListwiseQueueItemPublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { queue_id: queueId } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    const { sqlite } = getDb()
    const items = nextListwiseItems(sqlite, queueId, limit)
    // 一次取齐所有成员的图片行；已删除的图从组里静默消失，剩下的仍然可排。
    const posts = postsById(sqlite, items.flatMap(i => i.post_ids))
    return c.json(
      items.map(i => ({
        position: i.position,
        posts: i.post_ids.filter(pid => posts.has(pid)).map((pid) => {
          const p = posts.get(pid)!
          return toQueuePost(p)
        }),
      })),
      200,
    )
  },
)

const GenerateAbsoluteIn = z
  .object({
    dimensions: z.array(z.enum(VALID_DIMENSIONS)).min(1),
    scale: ScaleSchema,
    count: z.int().min(1),
    strategy: z.enum(VALID_STRATEGIES).default('random'),
    name: z.union([z.string(), z.null()]).optional(),
  })
  .openapi('GenerateAbsoluteIn')

const GeneratePairwiseIn = z
  .object({
    dimension: z.enum(VALID_DIMENSIONS),
    count: z.int().min(1),
    strategy: z.enum(VALID_PAIRWISE_STRATEGIES).default('random'),
    name: z.union([z.string(), z.null()]).optional(),
  })
  .openapi('GeneratePairwiseIn')

const GenerateListwiseIn = z
  .object({
    dimension: z.enum(VALID_DIMENSIONS),
    count: z.int().min(1),
    size: z.int().min(3).max(16).default(4),
    name: z.union([z.string(), z.null()]).optional(),
  })
  .openapi('GenerateListwiseIn')

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/generate-absolute',
    operationId: 'v2GenerateAbsolute',
    summary: 'GenerateAbsolute',
    description: 'Auto-generate an absolute queue by sampling the library (random / stratified by old score).',
    request: { body: { required: true, content: { 'application/json': { schema: GenerateAbsoluteIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...errors(400, 409),
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const { sqlite } = getDb()
    const postIds = samplePostIds(sqlite, { count: d.count, strategy: d.strategy, dimensions: d.dimensions })
    if (!postIds.length)
      return noCandidates('no eligible candidates (need posts with embeddings, not yet annotated or queued)')
    const name = d.name || `${d.strategy}-${d.dimensions.join('+')}-${postIds.length}`
    const id = createAbsoluteQueue(sqlite, { name, dimensions: d.dimensions, scale: d.scale, postIds })
    return c.json({
      id,
      name,
      kind: 'absolute' as const,
      dimensions: d.dimensions,
      scale: d.scale,
      total: postIds.length,
      done: 0,
    }, 201)
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/generate-pairwise',
    operationId: 'v2GeneratePairwise',
    summary: 'GeneratePairwise',
    description: 'Auto-generate a pairwise queue (random disjoint pairs, or content-similar + old-score-band pairs).',
    request: { body: { required: true, content: { 'application/json': { schema: GeneratePairwiseIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...errors(400, 409),
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const { sqlite } = getDb()
    const pairs = samplePairs(sqlite, { count: d.count, strategy: d.strategy, dimension: d.dimension })
    if (!pairs.length)
      return noCandidates('no eligible candidates (need posts with embeddings, not already queued)')
    const name = d.name || `pairs-${d.dimension}-${pairs.length}`
    const id = createPairwiseQueue(sqlite, { name, dimensions: [d.dimension], pairs, strategy: d.strategy })
    return c.json({
      id,
      name,
      kind: 'pairwise' as const,
      dimensions: [d.dimension],
      scale: null,
      total: pairs.length,
      done: 0,
      strategy: d.strategy,
    }, 201)
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/generate-listwise',
    operationId: 'v2GenerateListwise',
    summary: 'GenerateListwise',
    description: 'Auto-generate a listwise queue: groups of ~size posts whose silva scores sit in one close window, visually spread. Ranking one group yields C(size,2) boundary comparisons — worth Sum_{k=2..size}(1-1/k) in Plackett-Luce information, not C(size,2) independent observations.',
    request: { body: { required: true, content: { 'application/json': { schema: GenerateListwiseIn } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...errors(400, 409),
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    const { sqlite } = getDb()
    const groups = sampleGroups(sqlite, { count: d.count, size: d.size, dimension: d.dimension })
    if (!groups.length)
      return noCandidates('no eligible candidates (need silva-scored posts with an absolute score and embeddings)')
    const name = d.name || `listwise-${d.dimension}-${groups.length}x${d.size}`
    const id = createListwiseQueue(sqlite, { name, dimensions: [d.dimension], groups })
    return c.json({
      id,
      name,
      kind: 'listwise' as const,
      dimensions: [d.dimension],
      scale: null,
      total: groups.length,
      done: 0,
    }, 201)
  },
)
