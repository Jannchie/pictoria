/**
 * `POST /v2/posts/upload` —— 把一个 multipart 文件或一个远程 URL 变成一个 post。
 *
 * 从 `post-writes.ts` 拆出来：它是那里唯一往库里**新建**文件的写，带着自己的一套
 * 远程下载、文件名清洗和路径判定。挂载顺序紧跟 `postWritesRoutes`（`app.ts`），
 * OpenAPI 文档里的路径顺序因此不变。
 */
import { createRoute, z } from '@hono/zod-openapi'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { createPost, isImagePath } from '@pictoria/db'
import { newRoutes } from '../env.js'
import { CREATED, errors, fail, validationError } from '../openapi.js'
import { resolveLibraryPath, targetDir } from '../paths.js'
import { splitName } from '../sync.js'

/**
 * 二进制文件字段的文档元数据。单独提出来是因为 `contentMediaType` 只在 OAS 3.1
 * 里有，而 zod-to-openapi 的元数据类型是 3.0 ∩ 3.1 的公共键 —— 内联字面量会被
 * 多余属性检查拦下，走一个变量就不检查了；运行时它原样透传进 openapi.json。
 */
const BINARY_FILE_SCHEMA = { type: 'string', format: 'binary', contentMediaType: 'application/octet-stream' } as const

/** 上传表单。文件和 url 二选一，实际校验在 handler 里；这个 schema 只是文档。 */
const UploadFormData = z
  .object({
    url: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    file: z.any().openapi(BINARY_FILE_SCHEMA).optional(),
  })
  .openapi('UploadFormData')

export const postUploadRoutes = newRoutes()

/** 让 hotlink 有防护的站点（比如 pixiv 的 i.pximg.net）愿意给我们文件的普通浏览器 UA。 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

/** 远程上传的整个下载（连接 + 读完 body）最多等多久。挂住的上游不该占着请求不放。 */
const REMOTE_FETCH_TIMEOUT_MS = 30_000

/**
 * 把一个远程 URL 下成字节，只认 2xx 且 `content-type: image/*` 的响应。
 *
 * 原来是 `fetch` 完直接 `arrayBuffer()`：404 页、Cloudflare 的挑战页、防盗链返回的
 * HTML 都会被当成图片落盘建行，而 backfill 随后在它上面解码失败、把它拉进失败黑名单
 * —— 一张"图"从此在库里，打开是一页 HTML。失败时什么都不写（行和文件都不建）。
 */
async function fetchRemoteImage(url: string): Promise<{ ok: true, bytes: Buffer } | { ok: false, detail: string }> {
  const headers: Record<string, string> = { 'user-agent': BROWSER_UA }
  if (url.includes('pximg.net'))
    headers.referer = 'https://www.pixiv.net/'
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) })
    if (!r.ok)
      return { ok: false, detail: `Fetching ${url} failed: HTTP ${r.status}.` }
    const type = r.headers.get('content-type') ?? ''
    if (!type.toLowerCase().startsWith('image/'))
      return { ok: false, detail: `Fetching ${url} returned ${JSON.stringify(type || 'no content-type')}, not an image.` }
    return { ok: true, bytes: Buffer.from(await r.arrayBuffer()) }
  }
  catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? `timed out after ${REMOTE_FETCH_TIMEOUT_MS / 1000} s` : String(err)
    return { ok: false, detail: `Fetching ${url} failed: ${reason}.` }
  }
}

/**
 * 上传接受的扩展名：`isImagePath` 那一份，去掉 svg。
 *
 * svg 是能带脚本的文档：图片端点以 `image/svg+xml` 原样回它，直接打开就是 API 源上的
 * 一段任意脚本。sync 从磁盘导入的 svg 不受影响 —— 这里只管经 HTTP 写进来的。
 */
function isUploadableImage(filePath: string): boolean {
  return isImagePath(filePath) && !filePath.toLowerCase().endsWith('.svg')
}

/**
 * 客户端给的文件名 → 一个安全的单段文件名；清洗后什么都不剩就返回 `''`。
 *
 * 只保留最后一段（`a/b\c.png` → `c.png`：目录只能经 `path` 字段给，那条走包含判定）；
 * 去掉控制字符和 Windows 不许出现在文件名里的字符（`:` 是 ADS，`<>"|?*`）；剥掉首尾
 * 空白和末尾点号（Windows 会静默吃掉它们，`a.png.` 落盘成 `a.png`，与库里的行对不上）。
 */
function sanitizeFileName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\x00-\x1F\x7F<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '')
  return cleaned === '.' || cleaned === '..' ? '' : cleaned
}

/** URL 的最后一段路径作文件名：不带 query / fragment，百分号解码后再清洗。 */
function urlFileName(url: string): string {
  let last: string
  try {
    last = new URL(url).pathname.split('/').pop() ?? ''
  }
  catch {
    return ''
  }
  try {
    last = decodeURIComponent(last)
  }
  catch {}
  return sanitizeFileName(last)
}

/**
 * 把上传（multipart 文件**或**一个远程 URL）变成一个 post。
 *
 * 落库 + 落盘就结束 —— 剩下的（basics / 向量 / 标签 / 各种分）由 backfill 调度器
 * 在下一轮捡走，上传请求不占着 GPU。
 *
 * ⚠️ 先建行再写文件。反过来的话，两步之间跑一次 sync 会让 sync 自己把行建出来，
 * 紧接着这里的 INSERT 就多出一行重复。
 */
postUploadRoutes.openapi(
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
      201: { description: CREATED },
      ...errors(400, 409, 422),
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
      return fail(400, 'InvalidUploadError', 'Either file or url must be provided.')

    const fileName = hasFile ? sanitizeFileName((file as File).name) : ''
    if (hasFile && !fileName)
      return validationError(`invalid file name: ${JSON.stringify((file as File).name)}`)
    let rel: string
    if (!rawPath && fileName)
      rel = fileName
    else if (rawPath && fileName)
      rel = `${rawPath}/${fileName}`
    else rel = rawPath || (url ? urlFileName(url) : '')

    const base = targetDir()
    // 逃出库目录、或落进 `.pictoria/`（两个 sqlite、gallery-dl.conf —— 后者会被 URL 导入当
    // `--config` 读）就是**校验失败**，不是"文件已存在"。判定与图片端点共用 `resolveLibraryPath`。
    const absPath = resolveLibraryPath(rel)
    if (!absPath)
      return validationError(`path is not a writable library path: ${JSON.stringify(rel)}`)
    // 行的三元组按 sync 的拆法算（`splitName`），而且必须是 sync 扫盘时会得出的那一个 ——
    // 否则下一次 sync 看见的是"库里有、盘上没有"的行和"盘上有、库里没有"的文件，删前者
    // 时连原图一起 unlink。对不上号的名字在这里就拒掉，行和文件都不建：
    // - 没有扩展名（`.png` 按 sync 的拆法是主干 `.png`、扩展名空串）；
    // - 顶层以 `.` 开头的项（sync 整个跳过它们，见 `scanLibrary`）。
    const relPosix = path.relative(base, absPath).split(path.sep).join('/')
    const lastSlash = relPosix.lastIndexOf('/')
    const dir = lastSlash === -1 ? '.' : relPosix.slice(0, lastSlash)
    const [stem, extension] = splitName(relPosix.slice(lastSlash + 1))
    if (relPosix.startsWith('.'))
      return validationError(`path is not a writable library path: ${JSON.stringify(rel)}`)
    if (!extension || !isUploadableImage(absPath))
      return validationError(`not an accepted image file: ${JSON.stringify(rel)}`)
    if (fs.existsSync(absPath))
      return fail(409, 'FileAlreadyExistsError', 'File already exists.')

    let bytes: Buffer
    if (hasFile) {
      bytes = Buffer.from(await (file as File).arrayBuffer())
    }
    else {
      const fetched = await fetchRemoteImage(url!)
      if (!fetched.ok)
        return fail(422, 'UpstreamFetchError', fetched.detail)
      bytes = fetched.bytes
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true })

    try {
      createPost(c.var.db, {
        filePath: dir,
        fileName: stem,
        extension,
        source,
      })
    }
    catch (err) {
      // 上面的 existsSync 和这里之间隔着一次下载：同一路径的两个并发上传都会过那道检查，
      // 后到的那个撞上 posts 的 (file_path, file_name, extension) 唯一索引。那是"文件已
      // 存在"，不是服务器错误；也绝不能接着写文件，否则会盖掉先到那个的字节。
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
        return fail(409, 'FileAlreadyExistsError', 'File already exists.')
      throw err
    }
    fs.writeFileSync(absPath, bytes)
    return c.body(null, 201)
  },
)
