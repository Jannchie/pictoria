/**
 * posts 的列表、过滤搜索与文搜图。图搜图（`/similar`）在 `post-reads.ts`。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { decodeVector, INTERACTIVE_QUEUE, textEmbedTask } from '@pictoria/contracts'
import { listPaginated, listSimpleByIdsPreservingOrder, searchByTextVector, searchPosts, unratedArtistPickIds, type PostFilter as DbPostFilter, type PostFilterWithOrder } from '@pictoria/db'
import { getDb } from '../db.js'
import { PostFilterWithOrderSchema, TextSearchRequestSchema as TextSearchRequest } from '../filter-schema.js'
import { OK, errors, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, PostSimplePublic, toPostDetail, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'
import { getTasks } from '../tasks.js'

const CursorResponse = z
  .object({
    items: z.array(PostDetailPublic),
    nextCursor: z.int().nullable().optional(),
  })
  .openapi('CursorResponse')

export const postListRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

postListRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts',
    operationId: 'v2ListPosts',
    summary: 'ListPosts',
    description: 'Get all posts.',
    request: {
      query: z.object({
        // ⚠️ 顶层 `type` 覆盖会把 `default` 一起吃掉（zod-openapi 是整体替换 schema，
        // 不是合并）。要改 type 就得把 default 一并写回来。
        start: z.coerce.number().int().min(0).default(0)
          .openapi({ param: { name: 'start', in: 'query', required: false }, type: 'integer', default: 0 }),
        limit: z.coerce.number().int().min(1).default(100)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 100 }),
        lang: z.string().default('zh-Hans')
          .openapi({ param: { name: 'lang', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: CursorResponse } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { start, limit, lang } = c.req.valid('query')
    const { items, nextCursor } = listPaginated(getDb().sqlite, start, limit, n => translateTag(n, lang))
    return c.json({ items: items.map(toPostDetail), nextCursor }, 200)
  },
)

postListRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/search',
    operationId: 'v2SearchPosts',
    summary: 'SearchPosts',
    description: 'Search for posts by filters.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().default(100)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 100 }),
        offset: z.coerce.number().int().default(0)
          .openapi({ param: { name: 'offset', in: 'query', required: false }, type: 'integer', default: 0 }),
      }),
      body: { required: true, content: { 'application/json': { schema: PostFilterWithOrderSchema } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PostSimplePublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { limit, offset } = c.req.valid('query')
    const f = c.req.valid('json') as PostFilterWithOrder
    return c.json(searchPosts(getDb().sqlite, f, { limit, offset }).map(toPostSimple), 200)
  },
)

/**
 * 「未评分画师」的有序代表图 id 快照。
 *
 * 为什么要快照而不是每页重算：
 * - 用户在这个视图里就是在逐张打分，每打一张，那位画师就不再"未评分"，列表随之缩短。
 *   每页都现算的话 offset 会整体前移，第二页开头的若干画师被跳过、永远看不到。
 * - 整条查询在真库上约 1.3 s（阻塞事件循环），一次访问只付一次。
 * `offset === 0`（前端重新进入视图 / 刷新列表）时重算；翻页只切快照。
 */
let unratedArtistSnapshot: number[] | null = null

postListRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts/unrated-artist-picks',
    operationId: 'v2UnratedArtistPicks',
    summary: 'UnratedArtistPicks',
    description: 'One representative post (highest SILVA score) per artist tag that has no user-scored post. '
      + 'Ignores post filters. Offset 0 recomputes the ordered list; later pages slice that snapshot so rating while paging does not skip items.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).default(100)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 100 }),
        offset: z.coerce.number().int().min(0).default(0)
          .openapi({ param: { name: 'offset', in: 'query', required: false }, type: 'integer', default: 0 }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PostSimplePublic) } } },
      ...errors(400),
    },
  }),
  (c) => {
    const { limit, offset } = c.req.valid('query')
    const { sqlite } = getDb()
    if (offset === 0 || unratedArtistSnapshot === null)
      unratedArtistSnapshot = unratedArtistPickIds(sqlite)
    const ids = unratedArtistSnapshot.slice(offset, offset + limit)
    return c.json(listSimpleByIdsPreservingOrder(sqlite, ids).map(toPostSimple), 200)
  },
)

/**
 * 文搜图 —— 唯一一个**有人正在等**的 GPU 路径。
 *
 * 文本编码走 cairnq 的交互队列（worker 那边由第二个 Worker 实例伺候，poll 20ms），
 * 不和 backfill 抢同一条队列：共用的话一次搜索会卡在某批 embedding 后面几秒。
 */
postListRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/search/text',
    operationId: 'v2SearchPostsByText',
    summary: 'SearchPostsByText',
    description: 'Search posts by SigLIP 2 text embedding, combinable with the standard post filters.',
    request: {
      body: { required: true, content: { 'application/json': { schema: TextSearchRequest } } },
      query: z.object({
        limit: z.coerce.number().int().default(100)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 100 }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PostSimplePublic) } } },
      ...errors(400),
    },
  }),
  async (c) => {
    const data = c.req.valid('json')
    const { limit } = c.req.valid('query')
    const prompt = (data.query ?? '').trim()
    if (!prompt)
      return c.json([], 200)

    const tasks = await getTasks()
    const { embedding, scale, bias } = await tasks.call(textEmbedTask, { prompt }, {
      queue: INTERACTIVE_QUEUE,
      // 同一个 prompt 复用同一个任务：连打字带防抖也会重复提交同一串。
      key: `text-embed:${prompt}`,
      // key 就是 prompt 本身，同一串编码出来的向量是确定的 —— 复用成功的结果是
      // 真缓存。失败的那个仍然会被换掉，否则一次 worker OOM 会让这个词从此搜不了。
      conflict: 'reuse-succeeded',
      timeoutMs: 60_000,
      // 有人在等，不能用默认的 500ms 轮询（§4.6）；maxPollMs 把退避也按住 ——
      // 0.8 起轮询是纯状态探针（不回读 payload），50ms 一拍便宜到可以忽略。
      pollMs: 20,
      maxPollMs: 50,
      maxAttempts: 1,
    })

    const rows = searchByTextVector(getDb().sqlite, decodeVector(embedding), data as DbPostFilter, { limit })
    // SigLIP 官方的打分方式：sigmoid(scale * cos + bias)。向量在源头就已 L2 归一化
    // （ai/siglip_embed.py），所以 vec0 的余弦距离恰好是 (1 - cos)，能直接反推 cos。
    for (const r of rows) {
      const dist = r._knn_distance
      delete r._knn_distance
      if (dist === undefined || dist === null)
        continue
      const cos = 1 - Number(dist)
      r.match_prob = 1 / (1 + Math.exp(-(scale * cos + bias)))
    }
    return c.json(rows.map(toPostSimple), 200)
  },
)
