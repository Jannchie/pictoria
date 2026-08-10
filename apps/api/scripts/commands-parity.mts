#!/usr/bin/env node
// `/v2/cmd/*` 里那些**针对单张图**的即时命令的对拍。
//
//   node scripts/commands-parity.mjs        # 两侧都要在跑，且 cairnq worker 要在跑
//
// 这一组和 write-parity 一样是写路径，但麻烦在于"写"的内容是 GPU 算出来的：
// 分数只要算过一次就存下来，第二次调用返回的是存量。这反而让对拍变简单 ——
// 先让一侧算，再让另一侧读同一条存量，两边必须给出同一个数字。
//
// 但"存量命中"证明不了现算路径 —— 生产库里每张图的分都打满了，光比存量等于
// 只测了两个 SELECT。所以最后一段**故意把某张图的分删掉**，让两侧各自现算一次，
// 比完再把原值写回去。这需要直接开库，所以脚本住在 apps/api 里（同 worker-parity）。
//
// 真正会改数据的只有 auto-tags（它无条件覆写 rating 并插入 is_auto 标签），
// 所以那一段跑完会把 rating 还原、把新插进去的标签删掉。
import path from 'node:path'
import process from 'node:process'
import { createDb } from '@pictoria/db'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { sqlite } = createDb({ path: path.resolve(ROOT, 'server/illustration/images/.pictoria/pictoria.sqlite') })

const HONO = process.env.HONO_BASE ?? 'http://127.0.0.1:4777'
const LITESTAR = process.env.LITESTAR_BASE ?? 'http://127.0.0.1:4779'

/** 探测用的不存在 id。 */
const MISSING_ID = 999999999

const failures: Array<{ label: string, hono?: string, litestar?: string }> = []
let pass = 0

async function req(base: string, method: string, url: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(base + url, init)
  const text = await r.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  }
  catch {
    parsed = text
  }
  return { status: r.status, body: parsed }
}

function record(label: string, h: unknown, l: unknown) {
  const hs = JSON.stringify(h)
  const ls = JSON.stringify(l)
  if (hs === ls)
    pass++
  else failures.push({ label, hono: hs, litestar: ls })
}

// ─── 守卫：不存在 → 404，不是图片 → 400 ───────────────────────────
for (const cmd of ['waifu-scorer', 'silva-scorer', 'silva-luna-scorer']) {
  record(
    `GET /v2/cmd/${cmd}/${MISSING_ID}（不存在）`,
    await req(HONO, 'GET', `/v2/cmd/${cmd}/${MISSING_ID}`),
    await req(LITESTAR, 'GET', `/v2/cmd/${cmd}/${MISSING_ID}`),
  )
}
record(
  `PUT /v2/cmd/auto-tags/${MISSING_ID}（不存在）`,
  await req(HONO, 'PUT', `/v2/cmd/auto-tags/${MISSING_ID}`),
  await req(LITESTAR, 'PUT', `/v2/cmd/auto-tags/${MISSING_ID}`),
)

// 非图片走 400。库里不一定有这种行，没有就跳过而不是假装通过。
const nonImage = (await req(HONO, 'POST', '/v2/posts/search?limit=500', {})).body
  ?.find((p: any) => !['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg']
    .includes(String(p.extension).toLowerCase()))
if (nonImage) {
  for (const cmd of ['waifu-scorer', 'silva-scorer']) {
    record(
      `GET /v2/cmd/${cmd}/${nonImage.id}（非图片）`,
      await req(HONO, 'GET', `/v2/cmd/${cmd}/${nonImage.id}`),
      await req(LITESTAR, 'GET', `/v2/cmd/${cmd}/${nonImage.id}`),
    )
  }
}
else {
  console.log('（库里没有非图片的 post，跳过 400 守卫的对拍）')
}

// ─── 存量分数：两侧读同一条，必须同一个数字 ────────────────────────
const sample = (await req(HONO, 'POST', '/v2/posts/search?limit=5', {})).body ?? []
if (!sample.length)
  throw new Error('库里没有 post，无法对拍')

for (const post of sample.slice(0, 3)) {
  for (const [cmd, _label] of [['waifu-scorer', 'waifu'], ['silva-scorer', 'silva'], ['silva-luna-scorer', 'silva_luna']]) {
    // 先经 Hono（没算过就现算并落库），再经 Litestar 读同一条存量。
    const h = await req(HONO, 'GET', `/v2/cmd/${cmd}/${post.id}`)
    const l = await req(LITESTAR, 'GET', `/v2/cmd/${cmd}/${post.id}`)
    record(`GET /v2/cmd/${cmd}/${post.id}`, h, l)
  }
}

// ─── auto-tags：唯一真正会改数据的一个 ────────────────────────────
{
  const post = sample[0]
  const before = (await req(HONO, 'GET', `/v2/posts/${post.id}`)).body
  const beforeTags = new Set<string>(before.tags.map((t: any) => t.tagInfo.name))

  // Litestar 先跑，把该有的标签都插进去；Hono 再跑同一张，于是两次的返回体
  // 应当逐字段相同（第二次没有新标签可插，rating 也被写成同一个值）。
  const l = await req(LITESTAR, 'PUT', `/v2/cmd/auto-tags/${post.id}`)
  const h = await req(HONO, 'PUT', `/v2/cmd/auto-tags/${post.id}`)
  record(`PUT /v2/cmd/auto-tags/${post.id}`, stripVolatile(h), stripVolatile(l))

  // 还原：rating 写回原值，新插进来的标签删掉。
  await req(HONO, 'PUT', `/v2/posts/${post.id}/rating?rating=${before.rating}`)
  const after = (await req(HONO, 'GET', `/v2/posts/${post.id}`)).body
  for (const t of after.tags as any[]) {
    if (!beforeTags.has(t.tagInfo.name))
      await req(HONO, 'DELETE', `/v2/posts/${post.id}/tags/${encodeURIComponent(t.tagInfo.name)}`)
  }
  const restored = (await req(HONO, 'GET', `/v2/posts/${post.id}`)).body
  record(
    `auto-tags 后已还原 post ${post.id}`,
    { rating: restored.rating, tags: restored.tags.map((t: any) => t.tagInfo.name).sort() },
    { rating: before.rating, tags: [...beforeTags].sort() },
  )
}

// ─── 现算路径：把分删掉，逼两侧各算一次 ────────────────────────────
//
// 生产库里每张图的分都打满了，只比存量等于什么也没测。这里删掉一张图的分，
// 让 Litestar 现算一次、记下来，再删一次让 Hono 现算，两个数字必须逐位相同。
// 比完把原值写回去。
{
  const post = sample[1] ?? sample[0]
  const cases = [
    {
      cmd: 'waifu-scorer',
      read: () => sqlite.prepare<[number], { score: number }>(
        'SELECT score FROM post_waifu_scores WHERE post_id = ?').get(post.id)?.score ?? null,
      drop: () => sqlite.prepare('DELETE FROM post_waifu_scores WHERE post_id = ?').run(post.id),
      restore: (v: number) => sqlite.prepare(
        'INSERT INTO post_waifu_scores(post_id, score) VALUES (?, ?) '
        + 'ON CONFLICT (post_id) DO UPDATE SET score = excluded.score').run(post.id, v),
    },
    ...(['silva', 'silva_luna'] as const).map(scorer => ({
      cmd: scorer === 'silva' ? 'silva-scorer' : 'silva-luna-scorer',
      read: () => sqlite.prepare<[number, string], { score: number }>(
        'SELECT score FROM post_aesthetic_scores WHERE post_id = ? AND scorer = ?').get(post.id, scorer)?.score ?? null,
      drop: () => sqlite.prepare('DELETE FROM post_aesthetic_scores WHERE post_id = ? AND scorer = ?').run(post.id, scorer),
      restore: (v: number) => sqlite.prepare(
        'INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (?, ?, ?) '
        + 'ON CONFLICT (post_id, scorer) DO UPDATE SET score = excluded.score').run(post.id, scorer, v),
    })),
  ]

  for (const cse of cases) {
    const original = cse.read()
    try {
      cse.drop()
      const l = await req(LITESTAR, 'GET', `/v2/cmd/${cse.cmd}/${post.id}`)
      cse.drop()
      const h = await req(HONO, 'GET', `/v2/cmd/${cse.cmd}/${post.id}`)
      record(`GET /v2/cmd/${cse.cmd}/${post.id}（现算，非存量）`, h, l)
      // 现算之后必须真的落库了 —— 否则下一次调用还会再烧一次 GPU
      if (cse.read() !== null)
        pass++
      else failures.push({ label: `${cse.cmd} 现算后没有落库` })
    }
    finally {
      if (original !== null)
        cse.restore(original)
    }
  }
}

/** updatedAt 每次写都不同，比它没有意义。 */
function stripVolatile(r: any) {
  if (!r.body || typeof r.body !== 'object')
    return r
  const body = { ...r.body, updatedAt: null }
  if (Array.isArray(body.tags))
    body.tags = body.tags.map((t: any) => ({ ...t, tagInfo: { ...t.tagInfo, updatedAt: null, createdAt: null } }))
  return { status: r.status, body }
}

for (const f of failures) {
  console.log(`❌ ${f.label}`)
  console.log(`   hono    : ${f.hono?.slice(0, 300)}`)
  console.log(`   litestar: ${f.litestar?.slice(0, 300)}`)
}
console.log(`\n${failures.length === 0 ? '✅' : '💥'} ${pass} 项即时命令与 Litestar 一致（数据已还原）`)
sqlite.close()
process.exit(failures.length === 0 ? 0 : 1)
