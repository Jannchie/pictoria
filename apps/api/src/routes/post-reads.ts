/**
 * posts 的按 id 读取：详情 + 同组成员。
 *
 * 列表 / 搜索还没搬（它们要带排序、游标和向量距离，另开一组），仍走透传。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getDetail, getGroupMembers, groupHeadOf, knn, listEdgesFor, listSimpleByIdsPreservingOrder } from '@pictoria/db'
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

/**
 * 一个 post 参与的全部差分证据边，从它自己的视角看（对面是 `memberId`）。
 *
 * 单开一条而不是塞进 `/group`：那条返回的是 `PostSimplePublic[]`，是列表 / 网格
 * 到处在用的形状，往里加字段会牵动每一个消费它的地方。而这里要的东西恰好和"组成员"
 * 不重合 —— 用户裁决过但被判为不同的那些对，根本不在组里，却正是详情面板要标出来
 * "这个决定是手动做的、重组不会覆盖它"的依据。
 */
const GroupEvidenceItem = z
  .object({
    memberId: z.number().int(),
    siglipDist: z.number().nullable(),
    lpipsDist: z.number().nullable(),
    userVerdict: z.enum(['same', 'different']).nullable(),
  })
  .openapi('GroupEvidenceItem')

postReadsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/posts/{post_id}/group-evidence',
    operationId: 'v2GetPostGroupEvidence',
    summary: 'GetPostGroupEvidence',
    description: 'Per-pair near-duplicate evidence (distances + user verdicts) for this post.',
    request: {
      params: z.object({
        post_id: z.coerce.number().int()
          .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(GroupEvidenceItem) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    return c.json(listEdgesFor(getDb().sqlite, postId).map(e => ({
      memberId: e.postA === postId ? e.postB : e.postA,
      siglipDist: e.siglipDist,
      lpipsDist: e.lpipsDist,
      userVerdict: e.userVerdict,
    })))
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

    // 排除的是种子**所在的整个组**，不只是种子自己。
    //
    // 只排自己会造成一个不对称：站在代表上看，同组成员都被下面的 onlyCanonical
    // 滤掉了，结果干干净净；站在成员上看，它的代表是个 canonical，稳稳通过过滤，
    // 于是以 distance≈0 排在结果第一位 —— 用户看到的是"这张图和它自己最像"。
    // 组内的图彼此本来就该折叠成一条，从哪一张看都应该是同一个答案。
    const head = groupHeadOf(sqlite, postId) ?? postId

    // 取多于 limit 再过滤：onlyCanonical 的剔除发生在拿到 k 个近邻**之后**，
    // 直接取 limit + 1 会让"邻居里恰好有几个成员"的图只返回三四条。
    const sims = knn(sqlite, postId, limit * 2 + 2)
      .filter(([id]) => id !== postId && id !== head)
    if (!sims.length)
      return c.json([])

    // 余弦相似度（1 - 余弦距离）—— 和近重复分组用的是**同一个** SigLIP 2 度量，
    // 通过 match_prob 暴露出去，于是每张图能显示自己有多接近（近重复约 100%）。
    const similarityById = new Map(sims.map(([id, dist]) => [id, 1 - dist]))
    // only_canonical：相似搜索只呈现代表图，永不列出被折叠在它后面的副本。
    const rows = listSimpleByIdsPreservingOrder(sqlite, sims.map(([id]) => id), { onlyCanonical: true })
      .slice(0, limit)
    // 写进行里再交给 toPostSimple，而不是事后补 —— 键序是契约的一部分，
    // 事后赋值会把 matchProb 挤到对象末尾。
    for (const r of rows) r.match_prob = similarityById.get(r.id as number) ?? null
    return c.json(rows.map(toPostSimple))
  },
)
