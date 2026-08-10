#!/usr/bin/env node
// 图片端点的对拍 —— 二进制响应，比的是**头 + 字节**而不是 JSON。
//
//   node scripts/images-parity.mjs
//
// 分成三块：
//
// 1. 已有文件：四个端点各取几张，比 content-type / content-length /
//    content-disposition / cache-control / etag / last-modified 和整个响应体。
//    etag 尤其要比 —— 它的格式是 Litestar 从 Flask 抄的
//    `"{mtime}-{size}-{adler32(绝对路径)}"`，对不上意味着切过来之后浏览器手里
//    的缓存全部作废、全库图片重下一遍。
// 2. 现生成的缩略图：删掉再各让一侧生成一次，比字节。这是"缩略图交给 Python
//    worker 而不是在 TS 侧换 sharp"这个决定唯一的验证方式。
// 3. 路径逃逸：百分号编码的 `..` 必须两侧都 404，且 detail 文案一致。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HONO = process.env.HONO_BASE ?? 'http://127.0.0.1:4777'
const LITESTAR = process.env.LITESTAR_BASE ?? 'http://127.0.0.1:4779'
const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET_DIR = path.resolve(ROOT, 'server/illustration/images')
const THUMBS_DIR = path.resolve(TARGET_DIR, '.pictoria/thumbnails')

/**
 * 这些头是契约；`date` / `server` / 连接管理相关的不是。
 *
 * ⚠️ `content-length` **不在**这一列：Litestar 配了 `CompressionConfig(gzip)` 且
 * 不分 content-type，连 JPEG 也压（实测省 0.2%，纯烧 CPU）；Hono 的 compress
 * 按 content-type 白名单跳过图片。于是两侧的 content-length 一个是压缩后一个是
 * 原始大小，而解码后的字节完全相同 —— 比的是**内容**，不是它路上穿了什么。
 * 下面单独钉一条：Hono 不许 gzip 图片。
 */
const COMPARED_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
]

const failures = []
let pass = 0

async function get(base, url) {
  const r = await fetch(base + url)
  const headers = {}
  for (const h of COMPARED_HEADERS) {
    const v = r.headers.get(h)
    if (v !== null)
      headers[h] = v
  }
  return { status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) }
}

function compare(label, h, l) {
  const diffs = []
  if (h.status !== l.status)
    diffs.push(`状态 ${h.status} vs ${l.status}`)
  for (const key of COMPARED_HEADERS) {
    if (h.headers[key] !== l.headers[key])
      diffs.push(`${key}: ${h.headers[key]} vs ${l.headers[key]}`)
  }
  if (!h.body.equals(l.body))
    diffs.push(`响应体不同（${h.body.length} vs ${l.body.length} 字节）`)
  if (diffs.length)
    failures.push({ label, diffs })
  else pass++
}

// ─── 取几张真实存在的图 ─────────────────────────────────────────
const listed = await (await fetch(`${HONO}/v2/posts?limit=4`)).json()
const posts = (listed.items ?? []).filter(p => fs.existsSync(path.resolve(TARGET_DIR, p.fullPath)))
if (!posts.length)
  throw new Error('取不到任何本地存在的图片，无法对拍')

for (const post of posts) {
  for (const url of [
    `/v2/images/original/id/${post.id}`,
    `/v2/images/thumbnails/id/${post.id}`,
    `/v2/images/original/${post.fullPath}`,
    `/v2/images/thumbnails/${post.fullPath}`,
  ])
    compare(`GET ${url}`, await get(HONO, url), await get(LITESTAR, url))
}

// ─── 图片不该被 gzip ────────────────────────────────────────────
{
  const r = await fetch(`${HONO}/v2/images/original/id/${posts[0].id}`, {
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  })
  if (r.headers.get('content-encoding') === null)
    pass++
  else
    failures.push({ label: 'JPEG 被 gzip 了', diffs: [`content-encoding: ${r.headers.get('content-encoding')}`] })
}

// ─── 现生成的缩略图必须逐字节相同 ───────────────────────────────
//
// 不能拿磁盘上的存量当基准：它可能是旧版本的 basics worker 出的。基准必须是
// **此刻的**旧路径 —— 和 worker 对拍拒绝查 post_aesthetic_scores 是同一个理由。
{
  const post = posts[0]
  const thumbPath = path.resolve(THUMBS_DIR, post.fullPath)
  const url = `/v2/images/thumbnails/${post.fullPath}`
  const rm = () => { try { fs.unlinkSync(thumbPath) } catch {} }

  rm()
  const viaLitestar = await get(LITESTAR, url)
  rm()
  const viaHono = await get(HONO, url)

  if (viaHono.body.equals(viaLitestar.body) && viaHono.body.length > 0)
    pass++
  else
    failures.push({ label: '现生成的缩略图', diffs: [`${viaHono.body.length} vs ${viaLitestar.body.length} 字节`] })
}

// ─── 路径逃逸 ───────────────────────────────────────────────────
for (const url of [
  '/v2/images/original/%2e%2e%2f%2e%2e%2fwindows/win.ini',
  '/v2/images/thumbnails/%2e%2e%2f%2e%2e%2f%2e%2e%2fwindows/win.ini',
]) {
  const h = await get(HONO, url)
  const l = await get(LITESTAR, url)
  if (h.status === 404 && l.status === 404 && h.body.equals(l.body))
    pass++
  else
    failures.push({ label: `逃逸 ${url}`, diffs: [`${h.status}/${l.status}`, h.body.toString().slice(0, 120)] })
}

for (const f of failures) {
  console.log(`❌ ${f.label}`)
  for (const d of f.diffs) console.log(`   ${d}`)
}
console.log(`\n${failures.length === 0 ? '✅' : '💥'} ${pass} 项图片响应与 Litestar 一致（头 + 字节）`)
process.exit(failures.length === 0 ? 0 : 1)
