/**
 * posts 的列表与过滤搜索。
 *
 * `search/text`（SigLIP 2 文本向量）和 `similar`（图像向量 KNN）**不在这里** ——
 * 前者要调 Python 的文本编码器（§4.6 定的是走 cairnq，Phase 5 才接），后者依赖
 * 那条链路上的同一批代码。两个都还透传。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listPaginated, searchPosts, type PostFilterWithOrder } from '@pictoria/db'
import { getDb } from '../db.js'
import { PostFilterWithOrderSchema } from '../filter-schema.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, PostSimplePublic, toIsoDateTime, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

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
