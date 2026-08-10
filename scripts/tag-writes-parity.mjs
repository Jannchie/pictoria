#!/usr/bin/env node
// tag 写路径对拍：建/改/删 tag、给 post 打/摘 tag，每步做完都还原。
//
//   node scripts/tag-writes-parity.mjs
//
// 用带前缀的探针 tag 名，避免碰到库里真实的 tag。
const H = 'http://127.0.0.1:4777'
const L = 'http://127.0.0.1:4779'
const PROBE = '__parity_probe_tag'

async function req(base, method, url, body) {
  const init = { method }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body) }
  const r = await fetch(base + url, init)
  const t = await r.text()
  let b = null
  try { b = t ? JSON.parse(t) : null } catch { b = t }
  return { status: r.status, body: b }
}

let pass = 0
const fails = []
function cmp(label, a, b) {
  // updatedAt 会被写操作推进，两次调用时间不同，剔掉再比
  const strip = (x) => JSON.parse(JSON.stringify(x), (k, v) => (k === 'updatedAt' || k === 'updated_at' ? undefined : v))
  const x = JSON.stringify(strip(a))
  const y = JSON.stringify(strip(b))
  if (x === y) pass++
  else fails.push({ label, hono: x.slice(0, 220), litestar: y.slice(0, 220) })
}

const listed = await (await fetch(`${L}/v2/posts?limit=1`)).json()
const postId = listed.items[0].id

/** 每一轮：在一侧跑完整生命周期，返回各步响应；结束时不留痕。 */
async function cycle(base, suffix) {
  const name = `${PROBE}_${suffix}`
  const created = await req(base, 'POST', '/v2/tags', { name })
  const dup = await req(base, 'POST', '/v2/tags', { name })
  const groups = await req(base, 'GET', '/v2/tags/groups')
  const groupId = groups.body?.[0]?.id ?? null
  const updated = groupId ? await req(base, 'PUT', `/v2/tags/${name}`, { group_id: groupId }) : null
  const badGroup = await req(base, 'PUT', `/v2/tags/${name}`, { group_id: 999999 })
  const missing = await req(base, 'PUT', `/v2/tags/${PROBE}_nonexistent`, { group_id: null })

  const added = await req(base, 'PUT', `/v2/posts/${postId}/tags/${name}`)
  const addedTwice = await req(base, 'PUT', `/v2/posts/${postId}/tags/${name}`)
  const removed = await req(base, 'DELETE', `/v2/posts/${postId}/tags/${name}`)
  const removedTwice = await req(base, 'DELETE', `/v2/posts/${postId}/tags/${name}`)
  const missingPost = await req(base, 'PUT', `/v2/posts/999999999/tags/${name}`)

  const deleted = await req(base, 'DELETE', `/v2/tags/${name}`)
  const batch = await req(base, 'DELETE', '/v2/tags', { name_list: [`${name}_a`, `${name}_b`] })

  return { created, dup, updated, badGroup, missing, added, addedTwice, removed, removedTwice, missingPost, deleted, batch }
}

// 两轮用**同一个**探针名：每轮结束都自己清理干净，所以可以顺序复用。名字不同
// 会让 post 详情里的 tags 数组排序位置不同（按 group 再按 name），那是测试自身
// 的假差异。
const h = await cycle(H, 'probe')
const l = await cycle(L, 'probe')
for (const k of Object.keys(h)) cmp(`tag 生命周期 ${k}`, h[k], l[k])

// 收尾：探针 tag 一个都不该剩
const after = await req(L, 'GET', `/v2/tags?prev=${PROBE}&limit=20`)
const leftover = (after.body ?? []).filter((t) => t.name.startsWith(PROBE))
if (leftover.length) fails.push({ label: '探针 tag 残留', hono: leftover.map((t) => t.name).join(','), litestar: '（应为空）' })
else pass++

for (const f of fails) {
  console.log(`❌ ${f.label}`)
  console.log(`   hono    : ${f.hono}`)
  console.log(`   litestar: ${f.litestar}`)
}
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项 tag 写检查一致（探针已清理）`)
process.exit(fails.length === 0 ? 0 : 1)
