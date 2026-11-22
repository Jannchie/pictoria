/**
 * posts 的写：标量字段（score / rating / caption / source / touch / 批量）加上碰文件系统的
 * delete / rotate。上传在 `post-upload.ts`。
 */
import { createRoute, z } from '@hono/zod-openapi'
import { IO_QUEUE, rotateTask } from '@pictoria/contracts'
import { bulkUpdateField, clearCanonical, GRADING_SOURCES, getPostPath, groupHeadOf, groupTogether, makeCanonical, markDifferent, postExists, touchAccessed, updateField, updateForRotate } from '@pictoria/db'
import { type AppEnv, newRoutes } from '../env.js'
import type { Context } from 'hono'
import { boolQuery, OK, errors, fail, postNotFound } from '../openapi.js'
import { PostDetailPublic } from '../schemas.js'
import { postAbsPath, thumbnailPathFor } from '../paths.js'
import { deletePostFiles } from '../post-files.js'
import { postDetailResponse, postIdParam } from './post-shared.js'

const MAX_POST_SCORE = 5
const MAX_POST_RATING = 4

const ScoreUpdate = z
  .object({
    score: z.int().min(0).max(MAX_POST_SCORE).describe('Score from 0 to 5.'),
    // 写进 post_score_events.source。形状收死：这一列是给训练侧按情境切数据用的，
    // 放任自由文本进来，日后就没人说得清某个值是什么意思。
    source: z.enum(GRADING_SOURCES).optional()
      .describe('Where the grade was given. Omit for ordinary gallery scoring; `grade:<reason>` for the blind grading page.'),
  })
  .openapi('ScoreUpdate')

export const postWritesRoutes = newRoutes()

/** 更新一个标量列后回读详情。 */
function updateAndReturnDetail(c: Context<AppEnv, any, any>, postId: number, field: string, value: unknown, source: string | null = null) {
  if (!updateField(c.var.db, postId, field, value, source))
    return postNotFound(postId)
  return postDetailResponse(c, postId)
}

const detailResponse = {
  200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
  ...errors(400, 404),
}

/**
 * 批量：ids 与值都在 query 上，成功时 204 无响应体。
 *
 * ⚠️ **必须注册在 `/v2/posts/{post_id}/*` 之前** —— Hono 在同一个实例内按注册
 * 顺序匹配，否则 `/v2/posts/bulk/rating` 会先命中 `{post_id}`，把 "bulk" coerce
 * 成 NaN 然后报 400。
 */
const bulkUpdates = [
  { path: '/v2/posts/bulk/score', id: 'v2BulkUpdatePostScore', field: 'score', max: MAX_POST_SCORE },
  { path: '/v2/posts/bulk/rating', id: 'v2BulkUpdatePostRating', field: 'rating', max: MAX_POST_RATING },
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
          [b.field]: z.coerce.number().int().min(0).max(b.max)
            .openapi({ param: { name: b.field, in: 'query', required: true }, type: 'integer' }),
        }) as never,
      },
      responses: {
        204: { description: 'No Content' },
        ...errors(400),
      },
    }),
    (c) => {
      const q = c.req.valid('query') as Record<string, unknown>
      const ids = (Array.isArray(q.ids) ? q.ids : [q.ids]) as number[]
      bulkUpdateField(c.var.db, ids, b.field, q[b.field] as number)
      return c.body(null, 204)
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
  (c) => {
    const { score, source } = c.req.valid('json')
    return updateAndReturnDetail(c, c.req.valid('param').post_id, 'score', score, source ?? null)
  },
)

/** rating / caption / source 三个都把值放在 query 上，形状一致。 */
const queryUpdates = [
  {
    path: '/v2/posts/{post_id}/rating',
    id: 'v2UpdatePostRating',
    field: 'rating',
    schema: z.coerce.number().int().min(0).max(MAX_POST_RATING)
      .openapi({ param: { name: 'rating', in: 'query', required: true }, type: 'integer' }),
  },
  {
    path: '/v2/posts/{post_id}/caption',
    id: 'v2UpdatePostCaption',
    field: 'caption',
    schema: z.string().openapi({ param: { name: 'caption', in: 'query', required: true } }),
  },
  {
    path: '/v2/posts/{post_id}/source',
    id: 'v2UpdatePostSource',
    field: 'source',
    schema: z.string().openapi({ param: { name: 'source', in: 'query', required: true } }),
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
      return updateAndReturnDetail(c, c.req.valid('param').post_id, u.field, value)
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
      204: { description: 'No Content' },
      ...errors(400, 404),
    },
  }),
  (c) => {
    const { post_id: postId } = c.req.valid('param')
    if (!touchAccessed(c.var.db, postId))
      return postNotFound(postId)
    return c.body(null, 204)
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
      const sqlite = c.var.db
      if (!postExists(sqlite, postId))
        return postNotFound(postId)
      op.run(sqlite, postId)
      return postDetailResponse(c, postId)
    },
  )
}

/**
 * 手动合并：把选中的这些 post 并成一个差分组。
 *
 * 体里传 ids 而不是像 `bulk/*` 那样堆在 query 上：一次多选合并动辄几十个 id，
 * 重复的 `?ids=` 会把 URL 顶到网关的长度上限。
 *
 * 回读的是**canonical 的详情**，不是请求里的第一个 id：合并之后前端要跳到的是那个
 * 代表，而代表可能是这批 id 之外的（并进一个已有组时沿用原组封面）。
 */
postWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/group-together',
    operationId: 'v2GroupPostsTogether',
    summary: 'GroupPostsTogether',
    description: 'Merge these posts into one near-duplicate group (a manual user decision).',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              ids: z.array(z.int()).min(2).describe('Posts to put in one group.'),
              canonicalId: z.int().nullable().optional()
                .describe("The group's representative; defaults to the lowest id."),
            }).openapi('GroupTogetherIn'),
          },
        },
      },
    },
    responses: detailResponse,
  }),
  (c) => {
    const { ids, canonicalId } = c.req.valid('json')
    const sqlite = c.var.db
    const head = canonicalId ?? undefined
    for (const id of head == null ? ids : [...ids, head]) {
      if (!postExists(sqlite, id))
        return postNotFound(id)
    }
    if (!groupTogether(sqlite, ids, head))
      return fail(400, 'InvalidArgumentError', `Need at least 2 distinct posts to group, got ${new Set(ids).size}.`)

    // 合并后任一成员都能解析到代表：成员指向它，代表就是它自己。
    const canonical = groupHeadOf(sqlite, ids[0]!)
    if (canonical == null)
      return postNotFound(ids[0]!)
    return postDetailResponse(c, canonical)
  },
)

/**
 * 手动拆分：这两张不是同一张画。
 *
 * 裁决写进 `post_variant_edges`（重建时这条边被排除），如果它们此刻同组还会立刻拆开
 * —— 否则用户点完看不到任何变化。回读 `post_id` 的详情：调用方是它的详情面板。
 */
postWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/posts/{post_id}/not-same/{other_id}',
    operationId: 'v2MarkPostsDifferent',
    summary: 'MarkPostsDifferent',
    description: 'Record that these two posts are not the same picture, and split them apart now.',
    request: {
      params: z.object({
        post_id: postIdParam,
        other_id: z.coerce.number().int()
          .openapi({ param: { name: 'other_id', in: 'path', required: true }, type: 'integer' }),
      }),
    },
    responses: detailResponse,
  }),
  (c) => {
    const { post_id: postId, other_id: otherId } = c.req.valid('param')
    const sqlite = c.var.db
    if (!postExists(sqlite, postId))
      return postNotFound(postId)
    if (!postExists(sqlite, otherId))
      return postNotFound(otherId)
    if (!markDifferent(sqlite, postId, otherId))
      return fail(400, 'InvalidArgumentError', 'A post cannot differ from itself.')
    return postDetailResponse(c, postId)
  },
)

/**
 * 删 post：DB 行 + 原图 + 缩略图。`ids` 在 query 上（重复的 `?ids=1&ids=2`）。
 */
postWritesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/v2/posts/delete',
    operationId: 'v2DeletePosts',
    summary: 'DeletePosts',
    request: {
      query: z.object({
        ids: z.union([z.coerce.number().int(), z.array(z.coerce.number().int())])
          .openapi({ param: { name: 'ids', in: 'query', required: true }, type: 'array', items: { type: 'integer' } }),
      }),
    },
    responses: {
      204: { description: 'No Content' },
      ...errors(400),
    },
  }),
  async (c) => {
    const raw = c.req.queries('ids') ?? []
    const ids = raw.map(Number).filter(n => Number.isInteger(n))
    const sqlite = c.var.db
    await deletePostFiles(sqlite, ids)
    return c.body(null, 204)
  },
)

/**
 * 就地旋转一张图，回读详情。
 *
 * 解码 / 旋转 / 重编码在 worker 的 io 队列上（同缩略图）；改哪几列由这一侧决定。
 */
postWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/posts/{post_id}/rotate',
    operationId: 'v2RotatePostImage',
    summary: 'RotatePostImage',
    description: 'Rotate post image by id; updates sha256/width/height/arthash.',
    request: {
      params: z.object({ post_id: postIdParam }),
      query: z.object({ clockwise: boolQuery('clockwise', true) }),
    },
    responses: detailResponse,
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const { clockwise } = c.req.valid('query')

    const sqlite = c.var.db
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId)

    const tasks = await c.var.tasks.get()
    const result = await tasks.call(rotateTask, {
      originalPath: postAbsPath(post.fullPath),
      thumbnailPath: thumbnailPathFor(post.fullPath),
      clockwise,
    }, { queue: IO_QUEUE, timeoutMs: 120_000, maxAttempts: 1 })

    // `arthash` 写回 NULL 会让这张图重新变成 basics 待办 —— `updateForRotate` 自己
    // 会发重新待办信号（`packages/db` 的 `repending.ts`），这里不用管。
    updateForRotate(sqlite, postId, result)
    return postDetailResponse(c, postId)
  },
)
