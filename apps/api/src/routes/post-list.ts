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
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, PostSimplePublic, toIsoDateTime, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'
import { getTasks } from '../tasks.js'

const CursorResponse = z
  .object({
    // z.object({}) 会产出 properties:{} 和 additionalProperties，baseline 里
    // 两者都没有 —— 直接把 schema 覆盖成裸 { type: 'object' }。
    items: z.array(z.any().openapi({ type: 'object' })),
    nextCursor: z.int().nullable().optional(),
  })
  .openapi('CursorResponse')

export const postListRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/** 详情里的 tag 也要转 camelCase（嵌套的 snake_case 不在 toCamel 的处理范围）。 */
function camelTag(t: { is_auto: boolean, tag_info: Record<string, unknown> }) {
  const info = t.tag_info
  return {
    isAuto: t.is_auto,
    tagInfo: {
      group: info.group,
      name: info.name,
      translatedName: info.translated_name,
      updatedAt: toIsoDateTime(info.updated_at),
      createdAt: toIsoDateTime(info.created_at),
    },
  }
}

/** 键序照抄 PostDetailPublic 的声明顺序。 */
function toPostDetail(row: Record<string, any>) {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    extension: row.extension,
    fullPath: row.full_path,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspect_ratio,
    updatedAt: toIsoDateTime(row.updated_at),
    createdAt: toIsoDateTime(row.created_at),
    score: row.score,
    rating: row.rating,
    description: row.description,
    meta: row.meta,
    sha256: row.sha256,
    size: row.size,
    source: row.source,
    caption: row.caption,
    colors: row.colors,
    publishedAt: toIsoDateTime(row.published_at),
    dominantColor: row.dominant_color,
    arthash: row.arthash,
    canonicalPostId: row.canonical_post_id,
    groupMemberCount: row.group_member_count,
    waifuScore: row.waifu_score,
    aestheticScores: row.aesthetic_scores,
    tags: row.tags.map(camelTag),
  }
}

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
      return c.body(
        JSON.stringify({ detail: 'Start must be >= 0 and limit must be > 0.', error: 'InvalidArgumentError' }),
        // 409，不是 400 —— InvalidArgumentError 在 server/exceptions.py 里
        // 声明的就是 409（"值超出允许范围"，不是请求语法错）。
        409,
        { 'content-type': 'application/json' },
      ) as never
    }
    const { items, nextCursor } = listPaginated(getDb().sqlite, start, limit, n => translateTag(n, lang))
    return c.json({ items: items.map(toPostDetail), nextCursor })
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
    const { embedding, scale, bias } = await tasks.call(textEmbedTask, { prompt }, {
      queue: INTERACTIVE_QUEUE,
      // 同一个 prompt 复用同一个任务：连打字带防抖也会重复提交同一串。
      key: `text-embed:${prompt}`,
      conflict: 'reuse',
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
