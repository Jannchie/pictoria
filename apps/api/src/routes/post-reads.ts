/**
 * posts 的按 id 读取：详情 + 同组成员。
 *
 * 列表 / 搜索还没搬（它们要带排序、游标和向量距离，另开一组），仍走透传。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getDetail, getGroupMembers, knn, listSimpleByIdsPreservingOrder, type PostTag } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, PostSimplePublic, toIsoDateTime, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

export const postReadsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/** 嵌套结构里的 snake_case 也要转 —— toCamel 只处理顶层。 */
function camelTag(t: PostTag) {
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

postReadsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts/{post_id}',
    operationId: 'v2GetPost',
    summary: 'GetPost',
    request: {
      params: z.object({
        post_id: z.coerce.number().int()
          .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
      }),
      query: z.object({
        lang: z.string().default('zh-Hans')
          .openapi({ param: { name: 'lang', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { lang } = c.req.valid('query')
    const row = getDetail(getDb().sqlite, postId, n => translateTag(n, lang))
    if (!row) {
      // 形状照抄 Litestar 的领域错误：{detail, error}，**没有** status_code
      // 字段（那是校验错误 400 的形状）。契约里没声明 404，所以这里用
      // c.body 绕开 zod-openapi 的响应类型收窄。
      return c.body(
        JSON.stringify({ detail: `Post with id ${postId} not found.`, error: 'PostNotFoundError' }),
        404,
        { 'content-type': 'application/json' },
      ) as never
    }

    // 键序照抄 DTO 的声明顺序 —— 不是 SELECT 的列顺序。JSON 对象键序对
    // JSON.parse 无所谓，但逐字符对拍要求一致，前端快照测试也可能依赖它。
    return c.json({
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
    })
  },
)

postReadsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts/{post_id}/group',
    operationId: 'v2GetPostGroup',
    summary: 'GetPostGroup',
    description: "List the hidden near-duplicate members of this post's group.",
    request: {
      params: z.object({
        post_id: z.coerce.number().int()
          .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(PostSimplePublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    return c.json(getGroupMembers(getDb().sqlite, postId).map(toPostSimple))
  },
)

postReadsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts/{post_id}/similar',
    operationId: 'v2GetSimilarPosts',
    summary: 'GetSimilarPosts',
    request: {
      params: z.object({
        post_id: z.coerce.number().int()
          .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
      }),
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
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { limit } = c.req.valid('query')
    const { sqlite } = getDb()

    // k = limit + 1：种子自己会以 distance≈0 排在最前，要占掉一个名额。
    const sims = knn(sqlite, postId, limit + 1)
      .filter(([id]) => id !== postId)
      .slice(0, limit)
    if (!sims.length)
      return c.json([])

    // 余弦相似度（1 - 余弦距离）—— 和近重复分组用的是**同一个** SigLIP 2 度量，
    // 通过 match_prob 暴露出去，于是每张图能显示自己有多接近（近重复约 100%）。
    const similarityById = new Map(sims.map(([id, dist]) => [id, 1 - dist]))
    // only_canonical：相似搜索只呈现代表图，永不列出被折叠在它后面的副本。
    const rows = listSimpleByIdsPreservingOrder(sqlite, sims.map(([id]) => id), { onlyCanonical: true })
    // 写进行里再交给 toPostSimple，而不是事后补 —— 键序是契约的一部分，
    // 事后赋值会把 matchProb 挤到对象末尾。
    for (const r of rows) r.match_prob = similarityById.get(r.id as number) ?? null
    return c.json(rows.map(toPostSimple))
  },
)
