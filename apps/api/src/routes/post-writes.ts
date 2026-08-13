/**
 * posts 的写：标量字段（score / rating / caption / source / touch / 批量）加上四个
 * 碰文件系统的（delete / rotate / upload）。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import fs from 'node:fs'
import path from 'node:path'
import { IO_QUEUE, rotateTask } from '@pictoria/contracts'
import { Buffer } from 'node:buffer'
import { bulkUpdateField, clearCanonical, createPost, getDetail, getPostPath, makeCanonical, postExists, touchAccessed, updateField, updateForRotate } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, domainError, postNotFound, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, toPostDetail } from '../schemas.js'
import { targetDir, thumbnailsDir } from '../paths.js'
import { deletePostFiles } from '../post-files.js'
import { translateTag } from '../tag-i18n.js'
import { getTasks } from '../tasks.js'

const MAX_POST_SCORE = 5
const MAX_POST_RATING = 4

// score 的范围交给 zod：Litestar 侧 msgspec 同样在**校验层**拒绝，返回 400，
// 不是 handler 里的 InvalidArgumentError(409)。rating 则相反 —— 它在 query 上
// 没有 schema 约束，由 handler 判断，所以是 409。这个不对称是既有行为。
/** 上传表单，键序照抄 baseline：url → path → source → file。 */
const UploadFormData = z
  .object({
    url: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    // `.any()` 会让 zod-openapi 把它当可选，于是 required:['file'] 消失。
    // 这个 schema 只是文档 —— 实际校验在 handler 里 —— 所以 required 手工补上。
    file: z.any().openapi({ type: 'string', format: 'binary', contentMediaType: 'application/octet-stream' }),
  })
  .openapi('PostController.UploadFormData', { required: ['file'] })

const ScoreUpdate = z
  .object({ score: z.int().min(0).max(MAX_POST_SCORE).describe('Score from 0 to 5.') })
  .openapi('ScoreUpdate')

export const postWritesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/** 更新一个标量列后回读详情 —— 与 Python 侧 `_update_and_return_detail` 同语义。 */
function updateAndReturnDetail(postId: number, field: string, value: unknown) {
  const { sqlite } = getDb()
  if (!updateField(sqlite, postId, field, value))
    return postNotFound(postId)
  const detail = getDetail(sqlite, postId, n => translateTag(n))
  if (!detail)
    return postNotFound(postId)
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
      return postNotFound(postId) as never
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
        return postNotFound(postId) as never
      op.run(sqlite, postId)
      const detail = getDetail(sqlite, postId, n => translateTag(n))
      if (!detail)
        return postNotFound(postId) as never
      return Response.json(toPostDetail(detail)) as never
    },
  )
}

/**
 * 删 post：DB 行 + 原图 + 缩略图。
 *
 * `ids` 在 query 上（重复的 `?ids=1&ids=2`），不是请求体 —— 照抄 Litestar。
 * 成功是 204 无响应体。
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
      204: { description: 'Request fulfilled, nothing follows', headers: {} },
      ...RESP_400,
    },
  }),
  (c) => {
    const raw = c.req.queries('ids') ?? []
    const ids = raw.map(Number).filter(n => Number.isInteger(n))
    const { sqlite } = getDb()
    deletePostFiles(sqlite, ids)
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
      query: z.object({
        clockwise: z.coerce.boolean().default(true)
          .openapi({ param: { name: 'clockwise', in: 'query', required: false }, type: 'boolean', default: true }),
      }),
    },
    responses: detailResponse,
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    // `?clockwise=false` 必须是 false。z.coerce.boolean() 把任何非空串当成 true
    // （包括 "false"），所以这里自己解析。
    const rawClockwise = c.req.query('clockwise')
    const clockwise = rawClockwise === undefined ? true : !/^(?:false|0)$/i.test(rawClockwise)

    const { sqlite } = getDb()
    const post = getPostPath(sqlite, postId)
    if (!post)
      return postNotFound(postId) as never

    const base = targetDir()
    const tasks = await getTasks()
    const result = await tasks.call(rotateTask, {
      originalPath: path.resolve(base, post.fullPath),
      thumbnailPath: path.resolve(thumbnailsDir(), post.fullPath),
      clockwise,
    }, { queue: IO_QUEUE, waitTimeoutMs: 120_000, pollMs: 20, maxAttempts: 1 })

    updateForRotate(sqlite, postId, result)
    const detail = getDetail(sqlite, postId, n => translateTag(n))
    if (!detail)
      return postNotFound(postId) as never
    return c.json(toPostDetail(detail)) as never
  },
)

/** 让 hotlink 有防护的站点（比如 pixiv 的 i.pximg.net）愿意给我们文件的普通浏览器 UA。 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

/**
 * 把上传（multipart 文件**或**一个远程 URL）变成一个 post。
 *
 * 落库 + 落盘就结束 —— 剩下的（basics / 向量 / 标签 / 各种分）由 backfill 调度器
 * 在下一轮捡走。Python 侧原来是在请求里同步跑完整条 `process_post`，那让一次上传
 * 阻塞在 GPU 上好几秒；现在同样的活由同一批 worker 干，只是不占着请求。
 *
 * ⚠️ 先建行再写文件，顺序照抄 Python。反过来的话，两步之间跑一次 sync 会让 sync
 * 自己把行建出来，紧接着这里的 INSERT 就多出一行重复。
 */
postWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/upload',
    operationId: 'v2UploadFile',
    summary: 'UploadFile',
    tags: ['Posts', 'Upload'],
    request: {
      body: {
        required: true,
        content: { 'multipart/form-data': { schema: UploadFormData } },
      },
    },
    responses: {
      201: { description: 'Document created, URL follows', headers: {} },
      ...RESP_400,
    },
  }),
  async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    const url = (form.get('url') as string | null) || null
    const rawPath = (form.get('path') as string | null) || null
    const source = (form.get('source') as string | null) || 'unknown'

    const hasFile = file instanceof File && file.size > 0
    if (!hasFile && !url)
      return domainError('Either file or url must be provided.', 'InvalidUploadError', 400) as never

    // 路径解析顺序照抄 `UploadIntake._resolve_path`
    const fileName = hasFile ? (file as File).name : ''
    let rel: string
    if (!rawPath && fileName)
      rel = fileName
    else if (rawPath && fileName)
      rel = `${rawPath}/${fileName}`
    else rel = rawPath || (url ? url.split('/').pop()! : '')

    const base = targetDir()
    const absPath = path.resolve(base, rel)
    if (absPath !== base && !absPath.startsWith(base + path.sep))
      return domainError('File already exists.', 'FileAlreadyExistsError', 400) as never
    if (fs.existsSync(absPath))
      return domainError('File already exists.', 'FileAlreadyExistsError', 400) as never

    let bytes: Buffer
    if (hasFile) {
      bytes = Buffer.from(await (file as File).arrayBuffer())
    }
    else {
      const headers: Record<string, string> = { 'user-agent': BROWSER_UA }
      if (url!.includes('pximg.net'))
        headers.referer = 'https://www.pixiv.net/'
      const r = await fetch(url!, { headers })
      bytes = Buffer.from(await r.arrayBuffer())
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    const relPosix = path.relative(base, absPath).split(path.sep).join('/')
    const lastSlash = relPosix.lastIndexOf('/')
    const dir = lastSlash === -1 ? '.' : relPosix.slice(0, lastSlash)
    const nameWithExt = relPosix.slice(lastSlash + 1)
    const dot = nameWithExt.lastIndexOf('.')

    createPost(getDb().sqlite, {
      filePath: dir,
      fileName: dot === -1 ? nameWithExt : nameWithExt.slice(0, dot),
      extension: dot === -1 ? '' : nameWithExt.slice(dot + 1),
      source,
    })
    fs.writeFileSync(absPath, bytes)
    return c.body(null, 201) as never
  },
)
