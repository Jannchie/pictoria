#!/usr/bin/env node
// 写路径对拍 —— 对同一个 post 分别经 Hono 和 Litestar 做同一个写操作，比较
// 返回体和落库结果，**每一步做完都还原**。
//
//   node scripts/write-parity.mjs
//
// 和读路径分开的原因：读可以随便重放，写不能。这里每个用例都是
// 「记下原值 → 经 Hono 写 → 读回 → 还原 → 经 Litestar 写同样的值 → 读回 → 还原」，
// 然后比两次的返回体。跑完数据库应当回到起点。
import process from 'node:process'

const HONO = process.env.HONO_BASE ?? 'http://127.0.0.1:4777'
const LITESTAR = process.env.LITESTAR_BASE ?? 'http://127.0.0.1:4779'

async function req(base, method, url, body) {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(base + url, init)
  const text = await r.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: r.status, body: parsed }
}

/** 深比较；数值按解析后的值算，且忽略 updated_at（写操作必然改它，两次时间不同）。 */
function diff(a, b, path = '', out = []) {
  if (path.endsWith('updatedAt') || path.endsWith('updated_at')) return out
  if (Object.is(a, b)) return out
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb) {
    out.push({ path: path || '(根)', hono: a, litestar: b, why: `类型 ${ta} vs ${tb}` })
    return out
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push({ path, hono: `长度 ${a.length}`, litestar: `长度 ${b.length}`, why: '数组长度' })
      return out
    }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`, out)
    return out
  }
  if (ta === 'object') {
    const ka = Object.keys(a).join(',')
    const kb = Object.keys(b).join(',')
    if (ka !== kb) out.push({ path: path || '(根)', hono: ka, litestar: kb, why: '键' })
    for (const k of Object.keys(b)) if (k in a) diff(a[k], b[k], path ? `${path}.${k}` : k, out)
    return out
  }
  if (a !== b) out.push({ path, hono: a, litestar: b, why: '值不同' })
  return out
}

const failures = []
let pass = 0

function record(label, honoRes, litestarRes) {
  if (honoRes.status !== litestarRes.status) {
    failures.push({ label, diffs: [{ path: '(状态码)', hono: honoRes.status, litestar: litestarRes.status, why: 'HTTP 状态' }] })
    return
  }
  const diffs = diff(honoRes.body, litestarRes.body)
  if (diffs.length) failures.push({ label, diffs })
  else pass++
}

/** 跑一个写用例：两侧各写一次，各自还原。 */
async function bothWays(label, { read, write, restore }) {
  const before = await req(LITESTAR, 'GET', read)
  const original = before.body

  const h = await write(HONO)
  const afterHono = await req(LITESTAR, 'GET', read)
  await restore(LITESTAR, original)

  const l = await write(LITESTAR)
  const afterLitestar = await req(LITESTAR, 'GET', read)
  await restore(LITESTAR, original)

  record(label, h, l)
  record(`${label} → 落库结果`, afterHono, afterLitestar)

  const restored = await req(LITESTAR, 'GET', read)
  const drift = diff(restored.body, original)
  if (drift.length) failures.push({ label: `${label} → 还原后仍有残留`, diffs: drift })
  else pass++
}

const listed = await (await fetch(`${LITESTAR}/v2/posts?limit=2`)).json()
const [postId] = listed.items.map((i) => i.id)
if (!postId) throw new Error('库里没有 post，无法测写路径')

const readDetail = `/v2/posts/${postId}`

await bothWays('PUT score', {
  read: readDetail,
  write: (base) => req(base, 'PUT', `/v2/posts/${postId}/score`, { score: 4 }),
  restore: (base, o) => req(base, 'PUT', `/v2/posts/${postId}/score`, { score: o.score }),
})

await bothWays('PUT rating', {
  read: readDetail,
  write: (base) => req(base, 'PUT', `/v2/posts/${postId}/rating?rating=3`),
  restore: (base, o) => req(base, 'PUT', `/v2/posts/${postId}/rating?rating=${o.rating}`),
})

await bothWays('PUT caption', {
  read: readDetail,
  write: (base) => req(base, 'PUT', `/v2/posts/${postId}/caption?caption=${encodeURIComponent('对拍用标题')}`),
  restore: (base, o) => req(base, 'PUT', `/v2/posts/${postId}/caption?caption=${encodeURIComponent(o.caption ?? '')}`),
})

await bothWays('PUT source', {
  read: readDetail,
  write: (base) => req(base, 'PUT', `/v2/posts/${postId}/source?source=${encodeURIComponent('https://example.test/x')}`),
  restore: (base, o) => req(base, 'PUT', `/v2/posts/${postId}/source?source=${encodeURIComponent(o.source ?? '')}`),
})

// 越界校验：两侧都该拒绝，且状态码与错误体一致
record('PUT rating 越界', await req(HONO, 'PUT', `/v2/posts/${postId}/rating?rating=99`), await req(LITESTAR, 'PUT', `/v2/posts/${postId}/rating?rating=99`))
record('PUT score 越界', await req(HONO, 'PUT', `/v2/posts/${postId}/score`, { score: 99 }), await req(LITESTAR, 'PUT', `/v2/posts/${postId}/score`, { score: 99 }))
record('bulk score 越界', await req(HONO, 'PUT', `/v2/posts/bulk/score?ids=${postId}&score=99`), await req(LITESTAR, 'PUT', `/v2/posts/bulk/score?ids=${postId}&score=99`))
record('未知 post 的 score', await req(HONO, 'PUT', '/v2/posts/999999999/score', { score: 1 }), await req(LITESTAR, 'PUT', '/v2/posts/999999999/score', { score: 1 }))
record('未知 post 的 touch', await req(HONO, 'POST', '/v2/posts/999999999/touch'), await req(LITESTAR, 'POST', '/v2/posts/999999999/touch'))

// touch 只改 last_accessed_at，不改 updated_at —— 两侧都只该返回 204
record('POST touch', await req(HONO, 'POST', `/v2/posts/${postId}/touch`), await req(LITESTAR, 'POST', `/v2/posts/${postId}/touch`))

// 批量：写两个 id 再还原
{
  const ids = listed.items.map((i) => i.id)
  const originals = await Promise.all(ids.map((id) => req(LITESTAR, 'GET', `/v2/posts/${id}`)))
  const restoreAll = async (base) => {
    for (const [i, id] of ids.entries())
      await req(base, 'PUT', `/v2/posts/${id}/rating?rating=${originals[i].body.rating}`)
  }
  const q = `ids=${ids.join('&ids=')}&rating=2`
  const h = await req(HONO, 'PUT', `/v2/posts/bulk/rating?${q}`)
  const afterHono = await Promise.all(ids.map((id) => req(LITESTAR, 'GET', `/v2/posts/${id}`)))
  await restoreAll(LITESTAR)
  const l = await req(LITESTAR, 'PUT', `/v2/posts/bulk/rating?${q}`)
  const afterLitestar = await Promise.all(ids.map((id) => req(LITESTAR, 'GET', `/v2/posts/${id}`)))
  await restoreAll(LITESTAR)

  record('PUT bulk/rating', h, l)
  for (const [i] of ids.entries()) record(`PUT bulk/rating → post[${i}] 落库`, afterHono[i], afterLitestar[i])
}

for (const f of failures) {
  console.log(`❌ ${f.label}`)
  for (const d of f.diffs.slice(0, 5)) {
    console.log(`   ${d.path}  [${d.why}]`)
    console.log(`     hono    : ${JSON.stringify(d.hono)?.slice(0, 120)}`)
    console.log(`     litestar: ${JSON.stringify(d.litestar)?.slice(0, 120)}`)
  }
}

console.log(`\n${failures.length === 0 ? '✅' : '💥'} ${pass} 项写路径检查与 Litestar 一致（数据已还原）`)
process.exit(failures.length === 0 ? 0 : 1)
