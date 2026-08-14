/**
 * `/v2/images/*` —— 全站流量最大的四个端点：原图和缩略图，各有按路径和按 id 两种寻址。
 *
 * 三件事值得单独说：
 *
 * 1. **路由顺序**。`/original/{post_path}` 是通配的，必须排在 `/original/id/{post_id}`
 *    **后面**，否则 `id/5` 会被当成一个叫 "id/5" 的文件路径。Litestar 靠"字面量比
 *    参数更具体"自动处理，Hono 靠注册顺序。
 * 2. **路径是输入**。`{post_path}` 来自客户端且可能含 `..`（ASGI/Node 都在客户端
 *    归一化之后才百分号解码），直接 join 就能读到库外任意文件。一律 resolve 后
 *    要求仍在根之内，否则 404。
 * 3. **缩略图现生成走 worker**。库里现存的 22 万张缩略图是 PIL 出的，在 TS 侧换
 *    sharp 意味着新旧两批字节不同；交给 worker 的 io 队列既守住 §D1，也让
 *    basics worker 之后能复用同一段。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { IO_QUEUE, thumbnailTask } from '@pictoria/contracts'
import { getPostPath } from '@pictoria/db'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { getDb } from '../db.js'
import { RESP_400, httpError, zodErrorHook } from '../openapi.js'
import { presignGetObject } from '../s3.js'
import { resolveInside, targetDir, thumbnailsDir } from '../paths.js'
import { getTasks } from '../tasks.js'

export const imagesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/**
 * 前端的图片 URL 用 `?hash=<sha256>` 做内容寻址，所以一个 URL 永远对应同一串字节。
 * `immutable` 让浏览器连重新验证都省掉 —— 虚拟滚动的瀑布流会不停卸载/重挂图块，
 * 这一条省下的请求量很大。
 */
const IMAGE_CACHE = 'max-age=2592000, public, immutable'

/** 扩展名 → MIME。逐条抄自 `server/images.py` 顶部那串 `mimetypes.add_type`。 */
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
}

function guessType(filePath: string): string | undefined {
  return MIME[path.extname(filePath).slice(1).toLowerCase()]
}

/** Litestar `NotFoundException` 的响应体 —— 这个文件里出现 12 次，留个短名字。 */
function notFound(detail: string) {
  return httpError(404, detail)
}

/** Flask 传下来的那个 adler32，Litestar 的 etag 用它。Node 的 zlib 没有导出。 */
function adler32(input: string): number {
  const bytes = Buffer.from(input, 'utf8')
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/**
 * 一个文件的 200 响应，头逐个对齐 Litestar 的 `File`。
 *
 * etag 的格式是 `"{mtime}-{size}-{adler32(绝对路径)}"` —— Litestar 从 Flask 抄的。
 * 复刻它是为了让浏览器手里的旧缓存仍然能命中 304，而不是从 Hono 切过来之后
 * 全库图片重下一遍。
 */
function fileResponse(absPath: string): Response {
  let stat: fs.BigIntStats
  try {
    // ⚠️ `bigint: true`。`mtimeMs / 1000` 会掉精度：同一个文件 Node 给
    // 1736134859.4932125 而 Python 给 …22，etag 就对不上，浏览器手里的缓存
    // 全部作废。CPython 的 `st_mtime` 是 `sec + 1e-9 * nsec`（不是 ns/1e9），
    // 下面逐字复刻这个算式。
    stat = fs.statSync(absPath, { bigint: true })
  }
  catch {
    return notFound('Image not found')
  }

  const size = Number(stat.size)
  const mtime = Number(stat.mtimeNs / 1_000_000_000n) + 1e-9 * Number(stat.mtimeNs % 1_000_000_000n)

  const headers = new Headers({
    'cache-control': IMAGE_CACHE,
    'content-disposition': `inline; filename="${path.basename(absPath)}"`,
    'content-length': String(size),
    'last-modified': new Date(mtime * 1000).toUTCString(),
    'etag': `"${mtime}-${size}-${adler32(absPath)}"`,
  })
  const type = guessType(absPath)
  if (type)
    headers.set('content-type', type)

  return new Response(
    Readable.toWeb(fs.createReadStream(absPath)) as ReadableStream,
    { status: 200, headers },
  )
}

/**
 * 缩略图不在就现生成，生成不了就 404。
 *
 * 0 字节或损坏的原图会让 PIL 抛 `UnidentifiedImageError`（截断文件则是 `OSError`）。
 * 那是**数据**问题不是服务故障，所以翻译成 404 而不是让它冒成 500。
 */
async function ensureThumbnail(originalPath: string, thumbPath: string): Promise<Response | null> {
  if (fs.existsSync(thumbPath))
    return null
  const tasks = await getTasks()
  const result = await tasks.call(thumbnailTask, {
    originalPath,
    thumbnailPath: thumbPath,
  }, {
    queue: IO_QUEUE,
    // ⚠️ **不设 key**。用 `key` + `conflict: 'reuse'` 去重并发请求看着很顺手，但
    // cairnq 的 key 在任务完成之后依然有效：缩略图被删掉再请求，拿回的是上一次
    // 那个"已生成"的结论，于是文件不在、fileResponse 404，而且会一直 404。
    // 重复生成是幂等的、几十毫秒的 CPU，比这个陷阱便宜得多。
    waitTimeoutMs: 60_000,
    pollMs: 20,
    maxAttempts: 1,
  })
  if (!result.ok) {
    console.warn(`[images] 无法为 ${originalPath} 生成缩略图：${result.error}`)
    return notFound('Image cannot be decoded for thumbnail')
  }
  return null
}

/** File Download 响应的声明，逐字段抄自 baseline。 */
const FILE_RESPONSE = {
  200: {
    description: 'File Download',
    headers: {
      'content-length': { schema: { type: 'string' }, description: 'File size in bytes', required: false, deprecated: false },
      'last-modified': { schema: { type: 'string', format: 'date-time' }, description: 'Last modified data-time in RFC 2822 format', required: false, deprecated: false },
      'etag': { schema: { type: 'string' }, description: 'Entity tag', required: false, deprecated: false },
      'cache-control': { schema: { type: 'string' }, required: false, deprecated: false },
    },
    content: { '': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } },
  },
  ...RESP_400,
} as any

const postIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' })

const postPathParam = z.string()
  .openapi({ param: { name: 'post_path', in: 'path', required: true } })

// ⚠️ 按 id 的两条必须先注册：下面按路径的两条是通配的，会把 `id/5` 吞掉。
imagesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/images/original/id/{post_id}',
    operationId: 'v2GetOriginalById',
    summary: 'GetOriginalById',
    description: 'Get original image by post id, falling back to S3 if missing locally.',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: {
      200: {
        description: 'Request fulfilled, document follows',
        headers: { 'cache-control': { schema: { type: 'string' }, required: false, deprecated: false } },
        content: { 'application/json': { schema: {} } },
      },
      ...RESP_400,
    } as any,
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const post = getPostPath(getDb().sqlite, postId)
    if (!post)
      return notFound(`Post with id ${postId} not found`) as never

    const absPath = path.resolve(targetDir(), post.fullPath)
    if (fs.existsSync(absPath))
      return fileResponse(absPath) as never

    // 读路径上**永远不删** post：拿不到预签名链接、或 S3 返回非 200，多半是暂时的
    // （没配 S3、限流、网络抖动、时钟偏移导致的 403）。把它当作"图片没了"的证据
    // 曾在一次故障里批量删掉了 post。真正过期的行由 metadata sync 对账，不是由 GET。
    const link = presignGetObject(post.fullPath)
    if (!link)
      return notFound(`Original image for post ${postId} not found`) as never
    const upstream = await fetch(link)
    if (!upstream.ok) {
      console.warn(`[images] post ${postId} 的 S3 兜底返回 ${upstream.status}`)
      return notFound(`Failed to download original image for post ${postId}`) as never
    }
    const headers = new Headers({ 'cache-control': IMAGE_CACHE })
    const type = guessType(absPath)
    if (type)
      headers.set('content-type', type)
    return new Response(await upstream.arrayBuffer(), { status: 200, headers }) as never
  },
)

imagesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/images/thumbnails/id/{post_id}',
    operationId: 'v2GetThumbnailById',
    summary: 'GetThumbnailById',
    description: 'Get thumbnail image by post id (creates one if missing).',
    request: { params: z.object({ post_id: postIdParam }) },
    responses: FILE_RESPONSE,
  }),
  async (c) => {
    const { post_id: postId } = c.req.valid('param')
    const post = getPostPath(getDb().sqlite, postId)
    if (!post)
      return notFound(`Post with id ${postId} not found`) as never

    const originalPath = path.resolve(targetDir(), post.fullPath)
    if (!fs.existsSync(originalPath))
      return notFound(`Original image for post ${postId} not found`) as never

    const thumbPath = path.resolve(thumbnailsDir(), post.fullPath)
    const failed = await ensureThumbnail(originalPath, thumbPath)
    return (failed ?? fileResponse(thumbPath)) as never
  },
)

/**
 * 按路径的两条不能用 `createRoute` 注册。
 *
 * `@hono/zod-openapi` 把 `{post_path}` 转成 `:post_path`，而 Hono 的普通参数**不吃
 * 斜杠** —— `danbooru/wlop/x.jpg` 会匹配不上。所以文档和路由分开写：文档仍按
 * baseline 的 `{post_path}` 注册，路由用 Hono 的 `:post_path{.+}` 通配。
 */
function registerPathRoute(kind: 'original' | 'thumbnails', config: {
  operationId: string
  summary: string
  description: string
}) {
  imagesRoutes.openAPIRegistry.registerPath({
    method: 'get',
    path: `/v2/images/${kind}/{post_path}`,
    tags: ['Images'],
    ...config,
    request: { params: z.object({ post_path: postPathParam }) },
    responses: FILE_RESPONSE,
  })
}

registerPathRoute('original', {
  operationId: 'v2GetOriginal',
  summary: 'GetOriginal',
  description: 'Get original image by file path.',
})

imagesRoutes.get('/v2/images/original/:post_path{.+}', (c) => {
  const absPath = resolveInside(targetDir(), c.req.param('post_path') ?? '')
  // 逃逸和"文件不在"是两句不同的话 —— Litestar 的 _resolve_inside 抛的是
  // "Image not found"，只有存在性检查才说 "Original image not found"。
  if (!absPath)
    return notFound('Image not found')
  if (!fs.existsSync(absPath))
    return notFound('Original image not found')
  return fileResponse(absPath)
})

registerPathRoute('thumbnails', {
  operationId: 'v2GetThumbnail',
  summary: 'GetThumbnail',
  description: 'Get thumbnail image by file path (creates one if missing).',
})

imagesRoutes.get('/v2/images/thumbnails/:post_path{.+}', async (c) => {
  const rawPath = c.req.param('post_path') ?? ''
  const thumbPath = resolveInside(thumbnailsDir(), rawPath)
  const originalPath = resolveInside(targetDir(), rawPath)
  if (!thumbPath || !originalPath)
    return notFound('Image not found')
  if (!fs.existsSync(originalPath))
    return notFound('Original image not found')

  const failed = await ensureThumbnail(originalPath, thumbPath)
  return failed ?? fileResponse(thumbPath)
})
