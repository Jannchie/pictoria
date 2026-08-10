/**
 * posts 的标量字段写入：score / rating / caption / source / touch / 批量。
 *
 * 还留在代理上的写端点：`upload`（multipart + 落盘）、`rotate`（要重编码图片）、
 * `delete`（连带删文件和缩略图）。它们都碰文件系统，值得单独一趟。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bulkUpdateField, clearCanonical, getDetail, makeCanonical, postExists, touchAccessed, updateField } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, toIsoDateTime } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

const MAX_POST_SCORE = 5
const MAX_POST_RATING = 4

// score 的范围交给 zod：Litestar 侧 msgspec 同样在**校验层**拒绝，返回 400，
// 不是 handler 里的 InvalidArgumentError(409)。rating 则相反 —— 它在 query 上
// 没有 schema 约束，由 handler 判断，所以是 409。这个不对称是既有行为。
const ScoreUpdate = z
  .object({ score: z.int().min(0).max(MAX_POST_SCORE).describe('Score from 0 to 5.') })
  .openapi('ScoreUpdate')

export const postWritesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

function domainError(detail: string, error: string, status: 404 | 409) {
  return new Response(JSON.stringify({ detail, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function camelTag(t: { is_auto: boolean, tag_info: Record<string, any> }) {
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

/** 更新一个标量列后回读详情 —— 与 Python 侧 `_update_and_return_detail` 同语义。 */
function updateAndReturnDetail(postId: number, field: string, value: unknown) {
  const { sqlite } = getDb()
  if (!updateField(sqlite, postId, field, value))
    return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404)
  const detail = getDetail(sqlite, postId, n => translateTag(n))
  if (!detail)
    return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404)
  return Response.json(toPostDetail(detail))
}

const postIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' })

const detailResponse = {
  200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
  ...RESP_400,
}

/**
 * 批量：ids 与值都在 query 上，成功时 204 无响应体。
 *
 * ⚠️ **必须注册在 `/v2/posts/{post_id}/*` 之前** —— Hono 在同一个实例内按注册
 * 顺序匹配，否则 `/v2/posts/bulk/rating` 会先命中 `{post_id}`，把 "bulk" coerce
 * 成 NaN 然后报 400。
 */
const bulkUpdates = [
  { path: '/v2/posts/bulk/score', id: 'v2BulkUpdatePostScore', field: 'score', max: MAX_POST_SCORE, label: 'Score' },
  { path: '/v2/posts/bulk/rating', id: 'v2BulkUpdatePostRating', field: 'rating', max: MAX_POST_RATING, label: 'Rating' },
] as const

for (const b of bulkUpdates) {
  postWritesRoutes.openapi(
    createRoute({
      method: 'put',
      path: b.path,
      operationId: b.id,
      summary: b.id.replace(/^v2/, ''),
      request: {
        query: z.object({
          ids: z.union([z.coerce.number().int(), z.array(z.coerce.number().int())])
            .openapi({ param: { name: 'ids', in: 'query', required: true }, type: 'array', items: { type: 'integer' } }),
          [b.field]: z.coerce.number().int()
            .openapi({ param: { name: b.field, in: 'query', required: true }, type: 'integer' }),
        }) as never,
      },
      responses: {
        // 200 + `null` 体 —— handler 返回 None，Litestar 序列化成 JSON null。
        // 不是 204：契约里这两个端点声明的就是 200。
        200: { description: OK },
        ...RESP_400,
      },
    }),
    (c) => {
      const q = c.req.valid('query') as Record<string, unknown>
      const value = q[b.field] as number
      if (value < 0 || value > b.max)
        return domainError(`${b.label} must be between 0 and ${b.max}, got ${value}.`, 'InvalidArgumentError', 409) as never
      const ids = (Array.isArray(q.ids) ? q.ids : [q.ids]) as number[]
      bulkUpdateField(getDb().sqlite, ids, b.field, value)
      return c.json(null) as never
    },
  )
}

postWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/posts/{post_id}/score',
    operationId: 'v2UpdatePostScore',
    summary: 'UpdatePostScore',
    request: {
      params: z.object({ post_id: postIdParam }),
      body: { required: true, content: { 'application/json': { schema: ScoreUpdate } } },
    },
    responses: detailResponse,
  }),
  c => updateAndReturnDetail(c.req.valid('param').post_id, 'score', c.req.valid('json').score) as never,
)

/** rating / caption / source 三个都把值放在 query 上，形状一致。 */
const queryUpdates = [
  {
    path: '/v2/posts/{post_id}/rating',
    id: 'v2UpdatePostRating',
    field: 'rating',
    schema: z.coerce.number().int().openapi({ param: { name: 'rating', in: 'query', required: true }, type: 'integer' }),
    check: (v: number) => (v >= 0 && v <= MAX_POST_RATING
      ? null
      : `Rating must be between 0 and ${MAX_POST_RATING}, got ${v}.`),
  },
  {
    path: '/v2/posts/{post_id}/caption',
    id: 'v2UpdatePostCaption',
    field: 'caption',
    schema: z.string().openapi({ param: { name: 'caption', in: 'query', required: true } }),
    check: () => null,
  },
  {
    path: '/v2/posts/{post_id}/source',
    id: 'v2UpdatePostSource',
    field: 'source',
    schema: z.string().openapi({ param: { name: 'source', in: 'query', required: true } }),
    check: () => null,
  },
] as const

for (const u of queryUpdates) {
  postWritesRoutes.openapi(
    createRoute({
      method: 'put',
      path: u.path,
      operationId: u.id,
      summary: u.id.replace(/^v2/, ''),
      request: {
        params: z.object({ post_id: postIdParam }),
        query: z.object({ [u.field]: u.schema }) as never,
      },
      responses: detailResponse,
    }),
    (c) => {
      const value = (c.req.valid('query') as Record<string, unknown>)[u.field]
      const bad = (u.check as (v: unknown) => string | null)(value)
      if (bad)
        return domainError(bad, 'InvalidArgumentError', 409) as never
      return updateAndReturnDetail(c.req.valid('param').post_id, u.field, value) as never
    },
  )
}

postWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/{post_id}/touch',
    operationId: 'v2TouchPost',
    summary: 'TouchPost',
    description: 'Record a view by bumping last_accessed_at.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      204: { description: 'Request fulfilled, nothing follows' },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    if (!touchAccessed(getDb().sqlite, postId))
      return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never
    return c.body(null, 204) as never
  },
)

/** 分组重排：解组 / 提升为 canonical。两个都在成功后回读整个详情。 */
const groupOps = [
  {
    path: '/v2/posts/{post_id}/ungroup',
    id: 'v2UngroupPost',
    desc: 'Detach this post from its near-duplicate group (make it standalone).',
    run: (sqlite: any, postId: number) => clearCanonical(sqlite, [postId]),
  },
  {
    path: '/v2/posts/{post_id}/make-canonical',
    id: 'v2MakePostCanonical',
    desc: "Promote this group member to be the group's canonical representative.",
    run: (sqlite: any, postId: number) => makeCanonical(sqlite, postId),
  },
] as const

for (const op of groupOps) {
  postWritesRoutes.openapi(
    createRoute({
      method: 'put',
      path: op.path,
      operationId: op.id,
      summary: op.id.replace(/^v2/, ''),
      description: op.desc,
      request: { params: z.object({ post_id: postIdParam }) },
      responses: detailResponse,
    }),
    (c) => {
      const { post_id: postId } = c.req.valid('param')
      const { sqlite } = getDb()
      if (!postExists(sqlite, postId))
        return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never
      op.run(sqlite, postId)
      const detail = getDetail(sqlite, postId, n => translateTag(n))
      if (!detail)
        return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never
      return Response.json(toPostDetail(detail)) as never
    },
  )
}
