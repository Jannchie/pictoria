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
  nextAbsoluteItems,
  nextListwiseItems,
  nextPairwiseItems,
  postsById,
  sampleGroups,
  samplePairs,
  samplePostIds,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, pyRepr, RESP_400, validationError, zodErrorHook } from '../openapi.js'

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

const ListwiseQueueCreate = z
  .object({
    name: z.string(),
    dimensions: z.array(z.string()),
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
    method: 'post',
    path: '/v2/annotation-queues/listwise',
    operationId: 'v2CreateListwise',
    summary: 'CreateListwise',
    description: 'Create a listwise queue from an ordered list of post-id groups.',
    request: { body: { required: true, content: { 'application/json': { schema: ListwiseQueueCreate } } } },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueCreatedPublic } } },
      ...RESP_400,
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
    description: 'Next undone items of an absolute queue, with image info.',
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
    description: 'Next undone items of a pairwise queue, with image info for both posts.',
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
      ...RESP_400,
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
          return { id: p.post_id, filePath: p.file_path, fileName: p.file_name, extension: p.extension, sha256: p.sha256, width: p.width, height: p.height }
        }),
      })),
    )
  },
)

/** 与 Python 侧 `annotation_queues.py` 的常量一致。 */
const VALID_DIMENSIONS = ['color', 'finish', 'composition', 'overall'] as const
const VALID_SCALES = [2, 3, 5]
const VALID_STRATEGIES = ['random', 'stratified'] as const
const VALID_PAIRWISE_STRATEGIES = ['random', 'similar', 'close'] as const

const GenerateAbsoluteIn = z
  .object({
    dimensions: z.array(z.string()),
    scale: z.int(),
    count: z.int(),
    strategy: z.string().default('random'),
    name: z.union([z.string(), z.null()]).optional(),
  })
  .openapi('GenerateAbsoluteIn')

const GeneratePairwiseIn = z
  .object({
    dimension: z.string(),
    count: z.int(),
    strategy: z.string().default('random'),
    name: z.union([z.string(), z.null()]).optional(),
  })
  .openapi('GeneratePairwiseIn')

const GenerateListwiseIn = z
  .object({
    dimension: z.string(),
    count: z.int(),
    size: z.int().default(6),
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    if (!d.dimensions.length || d.dimensions.some((x: string) => !VALID_DIMENSIONS.includes(x as never)))
      return validationError(`invalid dimensions: ${pyRepr(d.dimensions)}`) as never
    if (!VALID_SCALES.includes(d.scale))
      return validationError(`invalid scale: ${d.scale}`) as never
    if (!VALID_STRATEGIES.includes(d.strategy as never))
      return validationError(`invalid strategy: ${pyRepr(d.strategy)}`) as never

    const { sqlite } = getDb()
    const postIds = samplePostIds(sqlite, { count: d.count, strategy: d.strategy, dimensions: d.dimensions })
    if (!postIds.length)
      return validationError('no eligible candidates (need posts with embeddings, not yet annotated or queued)') as never
    const name = d.name || `${d.strategy}-${d.dimensions.join('+')}-${postIds.length}`
    const id = createAbsoluteQueue(sqlite, { name, dimensions: d.dimensions, scale: d.scale, postIds })
    return c.json({
      id,
      name,
      kind: 'absolute',
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
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    if (!VALID_DIMENSIONS.includes(d.dimension as never))
      return validationError(`invalid dimension: ${pyRepr(d.dimension)}`) as never
    if (!VALID_PAIRWISE_STRATEGIES.includes(d.strategy as never))
      return validationError(`invalid strategy: ${pyRepr(d.strategy)}`) as never

    const { sqlite } = getDb()
    const pairs = samplePairs(sqlite, { count: d.count, strategy: d.strategy, dimension: d.dimension })
    if (!pairs.length)
      return validationError('no eligible candidates (need posts with embeddings, not already queued)') as never
    const name = d.name || `pairs-${d.dimension}-${pairs.length}`
    const id = createPairwiseQueue(sqlite, { name, dimensions: [d.dimension], pairs })
    return c.json({
      id,
      name,
      kind: 'pairwise',
      dimensions: [d.dimension],
      scale: null,
      total: pairs.length,
      done: 0,
    }, 201)
  },
)

annotationQueuesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/annotation-queues/generate-listwise',
    operationId: 'v2GenerateListwise',
    summary: 'GenerateListwise',
    description: 'Auto-generate a listwise queue: groups of ~size posts whose silva scores sit in one close window, visually spread. Ranking one group yields C(size,2) boundary comparisons.',
    request: { body: { required: true, content: { 'application/json': { schema: GenerateListwiseIn } } } },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: QueueSummaryPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const d = c.req.valid('json')
    if (!VALID_DIMENSIONS.includes(d.dimension as never))
      return validationError(`invalid dimension: ${pyRepr(d.dimension)}`) as never
    if (d.size < 3 || d.size > 16)
      return validationError(`invalid size: ${d.size} (want 3..16)`) as never

    const { sqlite } = getDb()
    const groups = sampleGroups(sqlite, { count: d.count, size: d.size, dimension: d.dimension })
    if (!groups.length)
      return validationError('no eligible candidates (need silva-scored posts with embeddings)') as never
    const name = d.name || `listwise-${d.dimension}-${groups.length}x${d.size}`
    const id = createListwiseQueue(sqlite, { name, dimensions: [d.dimension], groups })
    return c.json({
      id,
      name,
      kind: 'listwise',
      dimensions: [d.dimension],
      scale: null,
      total: groups.length,
      done: 0,
    }, 201)
  },
)
