/**
 * posts 的列表与过滤搜索。
 *
 * `search/text`（SigLIP 2 文本向量）和 `similar`（图像向量 KNN）**不在这里** ——
 * 前者要调 Python 的文本编码器（§4.6 定的是走 cairnq，Phase 5 才接），后者依赖
 * 那条链路上的同一批代码。两个都还透传。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { decodeVector, INTERACTIVE_QUEUE, textEmbedTask } from '@pictoria/contracts'
import { listPaginated, searchByTextVector, searchPosts, type PostFilter as DbPostFilter, type PostFilterWithOrder } from '@pictoria/db'
import { getDb } from '../db.js'
import { PostFilterWithOrderSchema, TextSearchRequestSchema as TextSearchRequest } from '../filter-schema.js'
import { OK, RESP_400, domainError, zodErrorHook } from '../openapi.js'
import { PostSimplePublic, toPostDetail, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'
import { callKeyed, getTasks } from '../tasks.js'

const CursorResponse = z
  .object({
    // z.object({}) 会产出 properties:{} 和 additionalProperties，baseline 里
    // 两者都没有 —— 直接把 schema 覆盖成裸 { type: 'object' }。
    items: z.array(z.any().openapi({ type: 'object' })),
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
        start: z.coerce.number().int().default(0)
          .openapi({ param: { name: 'start', in: 'query', required: false }, type: 'integer', default: 0 }),
        limit: z.coerce.number().int().default(100)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 100 }),
        lang: z.string().default('zh-Hans')
          .openapi({ param: { name: 'lang', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: CursorResponse } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { start, limit, lang } = c.req.valid('query')
    if (start < 0 || limit <= 0) {
      // 409，不是 400 —— InvalidArgumentError 在 server/exceptions.py 里
      // 声明的就是 409（"值超出允许范围"，不是请求语法错）。
      return domainError('Start must be >= 0 and limit must be > 0.', 'InvalidArgumentError', 409) as never
    }
    const { items, nextCursor } = listPaginated(getDb().sqlite, start, limit, n => translateTag(n, lang))
    return c.json({ items: items.map(toPostDetail), nextCursor })
  },
)

/**
 * `/v2/posts/` 是同一个端点的别名。
 *
 * Litestar 的控制器路径是 `/posts` 加一条 `/` 路由，所以**带斜杠**才是它的规范形式，
 * 不带的也一样能通。Hono 两者不通用，而代理还在的时候带斜杠的请求被悄悄透传走了，
 * 删掉代理才暴露出来。
 *
 * 只补这一条，不做全局的结尾斜杠归一化 —— 那会顺手改掉 `/v2/folders/`
 * （空目录名，Litestar 给的是 400 "不是库目录"）和 `/v2/folders/.` 的语义，
 * 把两个刻意的拒绝分支变成 404。
 *
 * 为什么是转发而不是把同一个 handler 再注册一次：`.openapi()` 把 zod 校验和路由
 * 注册绑成一件事，注册两次就会在 schema 里多出一个 operation，而契约锁死了 70 个。
 */
postListRoutes.get('/v2/posts/', (c) => {
  // 只改 pathname。拿整个 URL 做字符串替换也能work（`replace` 传字符串时只换首个
  // 匹配，而首个匹配必然在 path 里），但那是在赖一个不显眼的细节。
  const url = new URL(c.req.url)
  url.pathname = '/v2/posts'
  return postListRoutes.fetch(new Request(url, c.req.raw))
})

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
      ...RESP_400,
    },
  }),
  (c) => {
    const { limit, offset } = c.req.valid('query')
    const f = c.req.valid('json') as PostFilterWithOrder
    return c.json(searchPosts(getDb().sqlite, f, { limit, offset }).map(toPostSimple))
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
      ...RESP_400,
    },
  }),
  async (c) => {
    const data = c.req.valid('json')
    const { limit } = c.req.valid('query')
    const prompt = (data.query ?? '').trim()
    if (!prompt)
      return c.json([])

    const tasks = await getTasks()
    const { embedding, scale, bias } = await callKeyed(tasks, textEmbedTask, { prompt }, {
      queue: INTERACTIVE_QUEUE,
      // 同一个 prompt 复用同一个任务：连打字带防抖也会重复提交同一串。
      key: `text-embed:${prompt}`,
      // key 就是 prompt 本身，同一串编码出来的向量是确定的 —— 复用成功的结果是
      // 真缓存。失败的那个仍然会被换掉，否则一次 worker OOM 会让这个词从此搜不了。
      reuseSucceeded: true,
      waitTimeoutMs: 60_000,
      // 有人在等，不能用默认的 500ms 轮询（§4.6）。
      pollMs: 20,
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
    return c.json(rows.map(toPostSimple))
  },
)
