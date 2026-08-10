/**
 * 破坏性端点的对拍：delete / rotate / delete-folder。
 *
 *   pnpm parity:destructive        # 两侧都要在跑，cairnq worker 也要在跑
 *
 * 这三个端点没法拿库里现成的数据去比 —— 比一次就少一批。所以脚本自己在
 * `<target_dir>/__parity__/` 下造一次性的图和 post 行，两侧各操作一份**内容完全
 * 相同**的副本，然后比结果；跑完把目录和残留的行都清掉。
 *
 * rotate 尤其需要这种造数据的方式：JPEG 每转一次都重编码一次，拿真图来回转会
 * 无声地劣化用户的库。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createDb } from '@pictoria/db'

const HONO = process.env.HONO_BASE ?? 'http://127.0.0.1:4777'
const LITESTAR = process.env.LITESTAR_BASE ?? 'http://127.0.0.1:4779'
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TARGET_DIR = path.resolve(ROOT, 'server/illustration/images')
const THUMBS_DIR = path.resolve(TARGET_DIR, '.pictoria/thumbnails')
/** 一次性目录。名字够怪，不会撞上真实的图库目录。 */
const SANDBOX = '__parity__'

const { sqlite } = createDb({ path: path.resolve(TARGET_DIR, '.pictoria/pictoria.sqlite') })

const failures: Array<{ label: string, detail: string }> = []
let pass = 0

function check(label: string, ok: boolean, detail = '') {
  if (ok)
    pass++
  else failures.push({ label, detail })
}

async function req(base: string, method: string, url: string) {
  const r = await fetch(base + url, { method })
  const text = await r.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  }
  catch {
    body = text
  }
  return { status: r.status, body }
}

/** 找一张真图当模板。 */
const template = sqlite
  .prepare<[], { full_path: string }>(
    `SELECT full_path FROM posts WHERE LOWER(extension) = 'jpg' ORDER BY id LIMIT 1`,
  )
  .get()
if (!template)
  throw new Error('库里没有 jpg，无法造对拍样本')
const templateBytes = fs.readFileSync(path.resolve(TARGET_DIR, template.full_path))

/** 在沙箱里造一个 post（文件 + DB 行），返回它的 id 和相对路径。 */
function makePost(subdir: string, name: string): { id: number, rel: string } {
  const dir = path.resolve(TARGET_DIR, SANDBOX, subdir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.jpg`), templateBytes)
  const filePath = subdir ? `${SANDBOX}/${subdir}` : SANDBOX
  const info = sqlite
    .prepare(
      'INSERT INTO posts (file_path, file_name, extension, width, height) VALUES (?, ?, \'jpg\', 100, 100)',
    )
    .run(filePath, name)
  return { id: Number(info.lastInsertRowid), rel: `${filePath}/${name}.jpg` }
}

function cleanup() {
  sqlite
    .prepare(`DELETE FROM posts WHERE file_path = ? OR (file_path >= ? AND file_path < ?)`)
    .run(SANDBOX, `${SANDBOX}/`, `${SANDBOX}0`)
  fs.rmSync(path.resolve(TARGET_DIR, SANDBOX), { recursive: true, force: true })
  fs.rmSync(path.resolve(THUMBS_DIR, SANDBOX), { recursive: true, force: true })
}

cleanup()

try {
  // ─── rotate ─────────────────────────────────────────────────────
  //
  // 两份内容完全相同的副本，同一个方向各转一次，转出来的文件必须逐字节相同，
  // 返回的详情（去掉 id / 路径 / 时间戳）也必须相同。
  for (const clockwise of [true, false]) {
    const suffix = clockwise ? 'cw' : 'ccw'
    const a = makePost('rot', `hono-${suffix}`)
    const b = makePost('rot', `litestar-${suffix}`)
    const q = `?clockwise=${clockwise}`

    const h = await req(HONO, 'PUT', `/v2/posts/${a.id}/rotate${q}`)
    const l = await req(LITESTAR, 'PUT', `/v2/posts/${b.id}/rotate${q}`)

    check(`rotate ${suffix} 状态码`, h.status === l.status, `${h.status} vs ${l.status}`)

    const strip = (d: any) => d && {
      width: d.width,
      height: d.height,
      aspectRatio: d.aspectRatio,
      sha256: d.sha256,
      size: d.size,
      arthash: d.arthash,
    }
    check(
      `rotate ${suffix} 返回的详情`,
      JSON.stringify(strip(h.body)) === JSON.stringify(strip(l.body)),
      `${JSON.stringify(strip(h.body))}\n   vs ${JSON.stringify(strip(l.body))}`,
    )

    const fa = fs.readFileSync(path.resolve(TARGET_DIR, a.rel))
    const fb = fs.readFileSync(path.resolve(TARGET_DIR, b.rel))
    check(`rotate ${suffix} 磁盘上的图`, fa.equals(fb), `${fa.length} vs ${fb.length} 字节`)
    // 缩略图也要跟着重建 —— 忘了这一步，界面上会一直显示转之前的那张
    const ta = path.resolve(THUMBS_DIR, a.rel)
    const tb = path.resolve(THUMBS_DIR, b.rel)
    check(
      `rotate ${suffix} 重建了缩略图`,
      fs.existsSync(ta) && fs.existsSync(tb) && fs.readFileSync(ta).equals(fs.readFileSync(tb)),
    )
  }

  // 不存在的 id 两侧都要 404，且形状一致
  {
    const h = await req(HONO, 'PUT', '/v2/posts/999999999/rotate')
    const l = await req(LITESTAR, 'PUT', '/v2/posts/999999999/rotate')
    check('rotate 不存在的 post', JSON.stringify(h) === JSON.stringify(l), `${JSON.stringify(h)} vs ${JSON.stringify(l)}`)
  }

  // ─── delete ─────────────────────────────────────────────────────
  for (const [label, base] of [['hono', HONO], ['litestar', LITESTAR]] as const) {
    const one = makePost('del', `${label}-1`)
    const two = makePost('del', `${label}-2`)
    // 先请求一次缩略图，好让"删 post 也删缩略图"这一条真的被检验到
    await fetch(`${base}/v2/images/thumbnails/id/${one.id}`)

    const r = await req(base, 'DELETE', `/v2/posts/delete?ids=${one.id}&ids=${two.id}`)
    check(`delete(${label}) 返回 204`, r.status === 204, String(r.status))

    const left = sqlite
      .prepare<number[], { c: number }>('SELECT count(*) c FROM posts WHERE id IN (?, ?)')
      .get(one.id, two.id)!.c
    check(`delete(${label}) DB 行没了`, left === 0, `还剩 ${left} 行`)
    check(
      `delete(${label}) 原图和缩略图都没了`,
      !fs.existsSync(path.resolve(TARGET_DIR, one.rel))
      && !fs.existsSync(path.resolve(TARGET_DIR, two.rel))
      && !fs.existsSync(path.resolve(THUMBS_DIR, one.rel)),
    )
  }

  // 空 ids 是空操作而不是 500
  {
    const h = await req(HONO, 'DELETE', '/v2/posts/delete?ids=999999999')
    const l = await req(LITESTAR, 'DELETE', '/v2/posts/delete?ids=999999999')
    check('delete 不存在的 id', h.status === l.status, `${h.status} vs ${l.status}`)
  }

  // ─── delete folder ──────────────────────────────────────────────
  for (const [label, base] of [['hono', HONO], ['litestar', LITESTAR]] as const) {
    const folder = `${SANDBOX}/dir-${label}`
    const post = makePost(`dir-${label}`, 'a')
    // 非图片文件也要被整棵树带走
    fs.writeFileSync(path.resolve(TARGET_DIR, folder, 'note.txt'), 'x')

    const r = await req(base, 'DELETE', `/v2/folders/${folder}`)
    check(`delete-folder(${label}) 消息`, r.body?.msg === `Deleted folder ${folder} (1 posts)`, JSON.stringify(r))
    check(`delete-folder(${label}) 目录树没了`, !fs.existsSync(path.resolve(TARGET_DIR, folder)))
    const left = sqlite.prepare<[number], { c: number }>('SELECT count(*) c FROM posts WHERE id = ?').get(post.id)!.c
    check(`delete-folder(${label}) DB 行没了`, left === 0)
  }

  // 拒绝的分支：库根、库外、.pictoria
  for (const bad of ['', '.', '@', '..', '.pictoria', '.pictoria/thumbnails', 'does-not-exist']) {
    const url = `/v2/folders/${bad}`
    const h = await req(HONO, 'DELETE', url)
    const l = await req(LITESTAR, 'DELETE', url)
    check(`delete-folder 拒绝 '${bad}'`, JSON.stringify(h) === JSON.stringify(l), `${JSON.stringify(h)} vs ${JSON.stringify(l)}`)
  }
}
finally {
  cleanup()
  sqlite.close()
}

// 沙箱之外什么都不该动
const stray = spawnSync('git', ['status', '--porcelain', '--', 'server/illustration'], { cwd: ROOT, encoding: 'utf8' })
if (stray.stdout?.trim())
  console.log(`⚠️ 图库目录有未预期的改动:\n${stray.stdout}`)

for (const f of failures) {
  console.log(`❌ ${f.label}`)
  if (f.detail)
    console.log(`   ${f.detail}`)
}
console.log(`\n${failures.length === 0 ? '✅' : '💥'} ${pass} 项破坏性端点与 Litestar 一致（样本已清理）`)
process.exit(failures.length === 0 ? 0 : 1)
