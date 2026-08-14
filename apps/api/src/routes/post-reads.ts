/**
 * posts 的按 id 读取：详情 + 同组成员。
 *
 * 列表 / 搜索还没搬（它们要带排序、游标和向量距离，另开一组），仍走透传。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getDetail, getGroupMembers, knn, listSimpleByIdsPreservingOrder } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, postNotFound, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, PostSimplePublic, toPostDetail, toPostSimple } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

export const postReadsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

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
      return postNotFound(postId) as never
    }

    return c.json(toPostDetail(row))
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
