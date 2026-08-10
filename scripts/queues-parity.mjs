#!/usr/bin/env node
// 标注队列对拍：建队列 → 取件 → 列表，两侧各来一轮，跑完把探针队列删掉。
//
//   node scripts/queues-parity.mjs
const H = 'http://127.0.0.1:4777'
const L = 'http://127.0.0.1:4779'
const PROBE = '__parity_probe_queue'

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
  // 队列 id 是自增的，两轮必然不同 —— 抹掉再比
  const strip = (x) => JSON.stringify(x).replace(/"id":\d+/g, '"id":"<id>"')
  if (strip(a) === strip(b)) pass++
  else fails.push({ label, hono: strip(a).slice(0, 220), litestar: strip(b).slice(0, 220) })
}

const listed = await (await fetch(`${L}/v2/posts?limit=4`)).json()
const ids = listed.items.map((i) => i.id)

async function cycle(base) {
  const abs = await req(base, 'POST', '/v2/annotation-queues/absolute', {
    name: PROBE, dimensions: ['overall'], scale: 5, post_ids: ids,
  })
  const pw = await req(base, 'POST', '/v2/annotation-queues/pairwise', {
    name: PROBE, dimensions: ['overall'], pairs: [[ids[0], ids[1]], [ids[2], ids[3]]],
  })
  const nextAbs = await req(base, 'GET', `/v2/annotation-queues/${abs.body.id}/next-absolute?limit=3`)
  const nextAbsDefault = await req(base, 'GET', `/v2/annotation-queues/${abs.body.id}/next-absolute`)
  const nextPw = await req(base, 'GET', `/v2/annotation-queues/${pw.body.id}/next-pairwise?limit=1`)
  const emptyQueue = await req(base, 'GET', '/v2/annotation-queues/999999/next-absolute')
  // 只比这两个探针队列在列表里的样子，不比整张表（另一侧的探针也在里面）
  const all = await req(base, 'GET', '/v2/annotation-queues')
  const mine = { status: all.status, body: (all.body ?? []).filter((q) => q.name === PROBE && (q.id === abs.body.id || q.id === pw.body.id)) }
  return { abs, pw, nextAbs, nextAbsDefault, nextPw, emptyQueue, mine, queueIds: [abs.body.id, pw.body.id] }
}

const h = await cycle(H)
const l = await cycle(L)
for (const k of ['abs', 'pw', 'nextAbs', 'nextAbsDefault', 'nextPw', 'emptyQueue', 'mine']) cmp(`队列 ${k}`, h[k], l[k])

// 清理：API 里没有删队列的端点，所以直接开库删（items 有 FK，先删 items）。
// better-sqlite3 装在 packages/db 下，从那里解析。
{
  const path = await import('node:path')
  const { createRequire } = await import('node:module')
  const require = createRequire(path.resolve('packages/db/package.json'))
  const Database = require('better-sqlite3')
  const vec = require('sqlite-vec')
  const db = new Database(path.resolve('server/illustration/images/.pictoria/pictoria.sqlite'))
  vec.load(db)
  const qids = [...h.queueIds, ...l.queueIds]
  const ph = qids.map(() => '?').join(',')
  db.prepare(`DELETE FROM absolute_queue_items WHERE queue_id IN (${ph})`).run(...qids)
  db.prepare(`DELETE FROM pairwise_queue_items WHERE queue_id IN (${ph})`).run(...qids)
  const removed = db.prepare(`DELETE FROM annotation_queues WHERE id IN (${ph})`).run(...qids).changes
  db.close()
  if (removed !== qids.length) fails.push({ label: '探针队列清理', hono: `删了 ${removed} 个`, litestar: `应为 ${qids.length} 个` })
  else pass++
}

for (const f of fails) {
  console.log(`❌ ${f.label}`)
  console.log(`   hono    : ${f.hono}`)
  console.log(`   litestar: ${f.litestar}`)
}
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项队列检查一致（探针已清理）`)
process.exit(fails.length === 0 ? 0 : 1)
