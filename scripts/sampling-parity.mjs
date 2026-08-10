#!/usr/bin/env node
// 采样对拍：`sample-*` 与 `generate-*` 四个端点。
//
//   node scripts/sampling-parity.mjs
//
// 采样是随机的 —— 同一个端点连调两次结果就不同，所以这里**不能**比抽取本身。
// 比的是两侧都必须成立的那组不变量（资格、不相交、连通、不重问），加上错误路径
// 的逐字比对。不变量直接开库验证，而不是信端点自己报的数。
const H = 'http://127.0.0.1:4777'
const L = 'http://127.0.0.1:4779'

async function req(base, method, url, body) {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(base + url, init)
  const t = await r.text()
  let b = null
  try { b = t ? JSON.parse(t) : null } catch { b = t }
  return { status: r.status, body: b }
}

let pass = 0
const fails = []
function ok(label, cond, detail) {
  if (cond) pass++
  else fails.push({ label, hono: detail ?? '不成立', litestar: '不变量要求成立' })
}
function same(label, a, b) {
  const j = (x) => JSON.stringify(x)
  if (j(a) === j(b)) pass++
  else fails.push({ label, hono: j(a)?.slice(0, 220), litestar: j(b)?.slice(0, 220) })
}

// ─── 直接开库，用来验证端点报的东西是不是真的 ────────────────────
const path = await import('node:path')
const { createRequire } = await import('node:module')
const require = createRequire(path.resolve('packages/db/package.json'))
const Database = require('better-sqlite3')
const vec = require('sqlite-vec')
const db = new Database(path.resolve('server/illustration/images/.pictoria/pictoria.sqlite'), { readonly: false })
vec.load(db)

const ph = (n) => Array.from({ length: n }, () => '?').join(',')

/** 这些 id 里哪些**不**满足成对资格（canonical + 有向量 + 不在未完成队列项里）。 */
function ineligible(ids) {
  if (!ids.length) return []
  const bad = []
  const rows = db.prepare(`SELECT id, canonical_post_id FROM posts WHERE id IN (${ph(ids.length)})`).all(...ids)
  const known = new Map(rows.map((r) => [r.id, r.canonical_post_id]))
  const vecIds = new Set(
    db.prepare(`SELECT post_id FROM post_vectors_siglip2 WHERE post_id IN (${ph(ids.length)})`).all(...ids).map((r) => r.post_id),
  )
  const queued = new Set(
    db.prepare(
      `SELECT post_a AS id FROM pairwise_queue_items WHERE done = 0 AND post_a IN (${ph(ids.length)})`
      + ` UNION SELECT post_b FROM pairwise_queue_items WHERE done = 0 AND post_b IN (${ph(ids.length)})`,
    ).all(...ids, ...ids).map((r) => r.id),
  )
  for (const id of ids) {
    if (!known.has(id)) bad.push(`${id}:不存在`)
    else if (known.get(id) !== null) bad.push(`${id}:非 canonical`)
    else if (!vecIds.has(id)) bad.push(`${id}:无向量`)
    else if (queued.has(id)) bad.push(`${id}:已在未完成队列项`)
  }
  return bad
}

/** 绝对采样多两条：不在未完成的 absolute 队列项里，且未在请求维度上标注过。 */
function ineligibleAbsolute(ids, dimensions) {
  const bad = ineligible(ids).filter((s) => !s.endsWith('已在未完成队列项'))
  if (!ids.length) return bad
  const queued = new Set(
    db.prepare(`SELECT post_id FROM absolute_queue_items WHERE done = 0 AND post_id IN (${ph(ids.length)})`)
      .all(...ids).map((r) => r.post_id),
  )
  const annotated = new Set(
    db.prepare(
      `SELECT post_id FROM absolute_annotations WHERE post_id IN (${ph(ids.length)}) AND dimension IN (${ph(dimensions.length)})`,
    ).all(...ids, ...dimensions).map((r) => r.post_id),
  )
  for (const id of ids) {
    if (queued.has(id)) bad.push(`${id}:已在未完成绝对队列项`)
    if (annotated.has(id)) bad.push(`${id}:该维度已标注`)
  }
  return bad
}

const judged = new Set(
  db.prepare(`SELECT post_a, post_b FROM pairwise_annotations WHERE dimension = 'overall'`)
    .all().map((r) => (r.post_a < r.post_b ? `${r.post_a}:${r.post_b}` : `${r.post_b}:${r.post_a}`)),
)

// ─── 不变量：绝对采样 ───────────────────────────────────────────
const DIMS = ['overall', 'color']
for (const [side, base] of [['hono', H], ['litestar', L]]) {
  for (const strategy of ['random', 'stratified']) {
    const url = `/v2/annotations/sample-absolute?${DIMS.map((d) => `dimensions=${d}`).join('&')}&strategy=${strategy}&limit=8`
    const r = await req(base, 'GET', url)
    const ids = (r.body ?? []).map((p) => p.id)
    ok(`${side} absolute/${strategy} 200`, r.status === 200, `status=${r.status}`)
    ok(`${side} absolute/${strategy} 不超 limit`, ids.length <= 8, `拿到 ${ids.length}`)
    ok(`${side} absolute/${strategy} 无重复`, new Set(ids).size === ids.length)
    const bad = ineligibleAbsolute(ids, DIMS)
    ok(`${side} absolute/${strategy} 候选全部合格`, bad.length === 0, bad.join(', '))
    // 字段齐全 —— 少一个前端就渲染不出图块
    const missing = (r.body ?? []).filter((p) => ['id', 'filePath', 'fileName', 'extension', 'sha256', 'width', 'height'].some((k) => p[k] === undefined))
    ok(`${side} absolute/${strategy} 字段齐全`, missing.length === 0, `${missing.length} 条缺字段`)
  }
}

// ─── 不变量：成对采样 ───────────────────────────────────────────
for (const [side, base] of [['hono', H], ['litestar', L]]) {
  for (const strategy of ['random', 'similar', 'close']) {
    const r = await req(base, 'GET', `/v2/annotations/sample-pairwise?limit=8&strategy=${strategy}&dimension=overall`)
    const pairs = (r.body ?? []).map((p) => [p.postA.id, p.postB.id])
    ok(`${side} pairwise/${strategy} 200`, r.status === 200, `status=${r.status}`)
    ok(`${side} pairwise/${strategy} 不超 limit`, pairs.length <= 8, `拿到 ${pairs.length}`)
    ok(`${side} pairwise/${strategy} 无自配对`, pairs.every(([a, b]) => a !== b))

    const keys = pairs.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`))
    ok(`${side} pairwise/${strategy} 对不重复`, new Set(keys).size === keys.length)

    const bad = ineligible([...new Set(pairs.flat())])
    ok(`${side} pairwise/${strategy} 两侧图片全部合格`, bad.length === 0, bad.join(', '))

    if (strategy === 'close') {
      // close 刻意让图片跨对复现（那是它缝出一张图的方式），但绝不重问历史里判过的对，
      // 而且每个前缀必须连通 —— 标注者随时可以停，停在哪里那一段都得是一张连通图。
      ok(`${side} pairwise/close 不重问已判的对`, keys.every((k) => !judged.has(k)), keys.filter((k) => judged.has(k)).join(', '))
      let connected = true
      const seen = new Set(pairs.length ? pairs[0] : [])
      for (const [a, b] of pairs.slice(1)) {
        if (!seen.has(a) && !seen.has(b)) { connected = false; break }
        seen.add(a); seen.add(b)
      }
      ok(`${side} pairwise/close 每个前缀连通`, connected, keys.join(' '))
    }
    else {
      // random / similar 严格不相交：一张图在一批里至多出现一次
      const flat = pairs.flat()
      ok(`${side} pairwise/${strategy} 严格不相交`, new Set(flat).size === flat.length)
    }
  }
}

// ─── 错误路径：消息逐字比对（Python 的 repr 形状也在内） ───────────
for (const [label, url] of [
  ['非法 dimension', '/v2/annotations/sample-pairwise?dimension=bogus'],
  ['非法 pairwise strategy', '/v2/annotations/sample-pairwise?strategy=bogus'],
  ['非法 absolute strategy', '/v2/annotations/sample-absolute?dimensions=overall&strategy=bogus'],
  ['非法 dimensions 列表', '/v2/annotations/sample-absolute?dimensions=overall&dimensions=bogus'],
  ['空 dimensions', '/v2/annotations/sample-absolute?dimensions='],
]) {
  same(`采样错误 ${label}`, await req(H, 'GET', url), await req(L, 'GET', url))
}

// ─── generate-*：建真队列，比 summary 形状，跑完删掉 ──────────────
const queueIds = []
for (const [side, base] of [['hono', H], ['litestar', L]]) {
  const abs = await req(base, 'POST', '/v2/annotation-queues/generate-absolute', {
    dimensions: ['overall'], scale: 5, count: 4, strategy: 'random', name: `__parity_gen_abs_${side}`,
  })
  const pw = await req(base, 'POST', '/v2/annotation-queues/generate-pairwise', {
    dimension: 'overall', count: 4, strategy: 'random', name: `__parity_gen_pw_${side}`,
  })
  for (const r of [abs, pw]) if (r.body?.id) queueIds.push(r.body.id)

  ok(`${side} generate-absolute 201`, abs.status === 201, `status=${abs.status} ${JSON.stringify(abs.body)}`)
  ok(`${side} generate-pairwise 201`, pw.status === 201, `status=${pw.status} ${JSON.stringify(pw.body)}`)
  ok(`${side} generate-absolute summary`, abs.body?.kind === 'absolute' && abs.body?.scale === 5 && abs.body?.done === 0 && abs.body?.total > 0)
  ok(`${side} generate-pairwise summary`, pw.body?.kind === 'pairwise' && pw.body?.scale === null && pw.body?.done === 0 && pw.body?.total > 0)

  // total 必须是真写进去的项数，不是采样器自报的
  const absRows = db.prepare('SELECT COUNT(*) AS n FROM absolute_queue_items WHERE queue_id = ?').get(abs.body?.id ?? -1)
  const pwRows = db.prepare('SELECT COUNT(*) AS n FROM pairwise_queue_items WHERE queue_id = ?').get(pw.body?.id ?? -1)
  ok(`${side} generate-absolute total 与落库项数一致`, absRows.n === abs.body?.total, `库里 ${absRows.n} 报 ${abs.body?.total}`)
  ok(`${side} generate-pairwise total 与落库项数一致`, pwRows.n === pw.body?.total, `库里 ${pwRows.n} 报 ${pw.body?.total}`)
}

// 缺省名字的拼法是契约的一部分（前端把它当队列标题显示）
for (const [side, base] of [['hono', H], ['litestar', L]]) {
  const r = await req(base, 'POST', '/v2/annotation-queues/generate-absolute', {
    dimensions: ['overall', 'color'], scale: 5, count: 3, strategy: 'stratified',
  })
  if (r.body?.id) queueIds.push(r.body.id)
  ok(`${side} 缺省队列名 = strategy-dims-count`, r.body?.name === `stratified-overall+color-${r.body?.total}`, r.body?.name)
}

// generate-* 的错误路径
for (const [label, url, body] of [
  ['generate 非法 scale', '/v2/annotation-queues/generate-absolute', { dimensions: ['overall'], scale: 4, count: 2 }],
  ['generate 非法 dimensions', '/v2/annotation-queues/generate-absolute', { dimensions: ['bogus'], scale: 5, count: 2 }],
  ['generate 非法 strategy', '/v2/annotation-queues/generate-absolute', { dimensions: ['overall'], scale: 5, count: 2, strategy: 'bogus' }],
  ['generate 非法 dimension', '/v2/annotation-queues/generate-pairwise', { dimension: 'bogus', count: 2 }],
  ['generate 非法 pw strategy', '/v2/annotation-queues/generate-pairwise', { dimension: 'overall', count: 2, strategy: 'bogus' }],
]) {
  same(`采样错误 ${label}`, await req(H, 'POST', url, body), await req(L, 'POST', url, body))
}

// ─── 清理探针队列（没有删队列的端点，直接开库） ──────────────────
if (queueIds.length) {
  const p = ph(queueIds.length)
  db.prepare(`DELETE FROM absolute_queue_items WHERE queue_id IN (${p})`).run(...queueIds)
  db.prepare(`DELETE FROM pairwise_queue_items WHERE queue_id IN (${p})`).run(...queueIds)
  const removed = db.prepare(`DELETE FROM annotation_queues WHERE id IN (${p})`).run(...queueIds).changes
  ok('探针队列清理', removed === queueIds.length, `删了 ${removed}，应为 ${queueIds.length}`)
}
db.close()

for (const f of fails) {
  console.log(`❌ ${f.label}`)
  console.log(`   实际: ${f.hono}`)
  console.log(`   期望: ${f.litestar}`)
}
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项采样检查通过（探针队列已清理）`)
process.exit(fails.length === 0 ? 0 : 1)
