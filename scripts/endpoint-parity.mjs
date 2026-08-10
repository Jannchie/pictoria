#!/usr/bin/env node
// 端点对拍 —— 把同一个请求同时打给 Hono(4777) 和 Litestar(4779)，比较**解析后**的
// JSON，而不是字节。
//
//   node scripts/endpoint-parity.mjs           # 跑内置用例集
//   node scripts/endpoint-parity.mjs GET /v2/statistics
//
// 为什么不比字节：Python 把 float 3.0 序列化成 `3.0`，JS 只能产出 `3`。两者
// JSON.parse 之后是同一个 number，前端行为完全一致，但字节比较会红成一片。
// 反过来，键的**顺序**是要管的 —— hey-api 按顺序生成 TS，快照测试也可能依赖它，
// 所以这里单独比较键序。
import process from 'node:process'

const HONO = process.env.HONO_BASE ?? 'http://127.0.0.1:4777'
const LITESTAR = process.env.LITESTAR_BASE ?? 'http://127.0.0.1:4779'

/** 深比较，float 按解析后的值算。返回差异路径列表。 */
function diff(a, b, path = '', out = []) {
  if (Object.is(a, b)) return out

  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb) {
    out.push({ path: path || '(根)', hono: a, litestar: b, why: `类型 ${ta} vs ${tb}` })
    return out
  }

  if (ta === 'number') {
    // 解析后严格相等即可 —— 3 和 3.0 是同一个值
    if (a !== b) out.push({ path, hono: a, litestar: b, why: '数值不同' })
    return out
  }
  if (ta !== 'object' && ta !== 'array') {
    if (a !== b) out.push({ path, hono: a, litestar: b, why: '值不同' })
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

  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.join(',') !== kb.join(',')) {
    const missing = kb.filter((k) => !ka.includes(k))
    const extra = ka.filter((k) => !kb.includes(k))
    if (missing.length || extra.length) {
      out.push({
        path: path || '(根)',
        hono: extra.length ? `多出 ${extra.join(',')}` : '—',
        litestar: missing.length ? `缺少 ${missing.join(',')}` : '—',
        why: '键集合',
      })
    } else {
      out.push({ path: path || '(根)', hono: ka.join(','), litestar: kb.join(','), why: '键顺序' })
    }
  }
  for (const k of kb) if (k in a) diff(a[k], b[k], path ? `${path}.${k}` : k, out)
  return out
}

async function fetchBoth(method, url, body) {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const [h, l] = await Promise.all([fetch(HONO + url, init), fetch(LITESTAR + url, init)])
  return {
    hono: { status: h.status, body: await h.json().catch(() => null) },
    litestar: { status: l.status, body: await l.json().catch(() => null) },
  }
}

const FILTERS = [
  {},
  { rating: [1, 2] },
  { only_canonical: false },
  { tags: ['1girl'], extension: ['jpg'] },
  { waifu_score_levels: ['A', 'UNSCORED'] },
  { silva_score_levels: ['A'], silva_luna_score_levels: ['B'] },
  { folder: 'danbooru/wlop' },
]

async function buildCases() {
  const cases = [
    ['GET', '/v2/statistics'],
    ['GET', '/v2/folders'],
    ['GET', '/v2/tags?limit=5'],
    ['GET', '/v2/tags?limit=5&lang=en'],
    ['GET', '/v2/tags?prev=1girl&limit=3'],
    ['GET', '/v2/tags/groups'],
  ]

  const listed = await (await fetch(`${LITESTAR}/v2/posts/?limit=5`)).json()
  const ids = [...(listed.items ?? []).map((i) => i.id), 137, 999999999]
  for (const id of ids) {
    cases.push(['GET', `/v2/posts/${id}`])
    cases.push(['GET', `/v2/posts/${id}?lang=en`])
    cases.push(['GET', `/v2/posts/${id}/group`])
  }

  // 列表：游标分页 + 语言
  for (const q of ['', '?limit=3', '?start=100&limit=5', '?limit=3&lang=en', '?limit=0', '?start=-1'])
    cases.push(['GET', `/v2/posts/${q}`])

  // 搜索：三种排序模式 × 虚拟排序列 × lab 距离
  const searches = [
    {},
    { order_by: 'id', order: 'asc' },
    { order_by: 'score', order: 'desc' },
    { order_by: 'created_at', order: 'asc' },
    { order_by: 'waifu_score', order: 'desc' },
    { order_by: 'silva_score', order: 'desc' },
    { order_by: 'silva_luna_score', order: 'asc' },
    { order_by: 'discrepancy', order: 'desc' },
    { order: 'random', order_seed: 42 },
    { order: 'random', order_seed: 42, order_by: 'score', sort_direction: 'asc' },
    { order: 'random', order_seed: 7, order_by: 'waifu_score', sort_direction: 'desc' },
    { lab: [50, 10, -20] },
    { lab: [50, 10, -20], rating: [1, 2] },
    { tags: ['1girl'], order_by: 'score', order: 'desc' },
    { only_canonical: false, order_by: 'id', order: 'desc' },
    { waifu_score_levels: ['A'], order_by: 'waifu_score', order: 'desc' },
  ]
  for (const body of searches) cases.push(['POST', '/v2/posts/search?limit=5', body])
  cases.push(['POST', '/v2/posts/search?limit=3&offset=10', { order_by: 'id', order: 'asc' }])

  for (const ep of [
    '/v2/posts/count',
    '/v2/posts/count/rating',
    '/v2/posts/count/score',
    '/v2/posts/count/extension',
    '/v2/posts/count/waifu',
    '/v2/posts/count/silva',
    '/v2/posts/count/silva-luna',
    '/v2/posts/stats',
  ]) for (const f of FILTERS) cases.push(['POST', ep, f])

  // count/tags 吃的是 TagCountRequest（PostFilter + query/limit/lang），所以单列。
  // 三条路径都要走到：无过滤器的快路径（读 tags.post_count）、有过滤器的实时
  // GROUP BY、以及本地化搜索（"绿眼" 要能命中 green_eyes）。LIKE 元字符也钉一下 ——
  // 搜索框里打 '%' 必须按字面匹配而不是通配。
  for (const f of FILTERS) cases.push(['POST', '/v2/posts/count/tags', { ...f, limit: 20 }])
  for (const extra of [
    { query: 'girl', limit: 10 },
    { query: 'green', limit: 10 },
    { query: '绿眼', limit: 10 },
    { query: '绿眼', limit: 10, lang: 'en' },
    { query: '%', limit: 10 },
    { query: '_', limit: 10 },
    { query: 'zzzzzzzz-no-such-tag', limit: 10 },
    { query: 'girl', limit: 10, rating: [1, 2] },
    { query: 'girl', limit: 10, only_canonical: false },
    { limit: 5 },
  ]) cases.push(['POST', '/v2/posts/count/tags', extra])

  return cases
}

const argv = process.argv.slice(2)
const cases = argv.length >= 2 ? [[argv[0], argv[1], argv[2] ? JSON.parse(argv[2]) : undefined]] : await buildCases()

let pass = 0
const failures = []
for (const [method, url, body] of cases) {
  const { hono, litestar } = await fetchBoth(method, url, body)
  const label = `${method} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`

  if (hono.status !== litestar.status) {
    failures.push({ label, diffs: [{ path: '(状态码)', hono: hono.status, litestar: litestar.status, why: 'HTTP 状态' }] })
    continue
  }
  const diffs = diff(hono.body, litestar.body)
  if (diffs.length) failures.push({ label, diffs })
  else pass++
}

for (const f of failures) {
  console.log(`❌ ${f.label}`)
  for (const d of f.diffs.slice(0, 6)) {
    console.log(`   ${d.path}  [${d.why}]`)
    console.log(`     hono    : ${JSON.stringify(d.hono)?.slice(0, 140)}`)
    console.log(`     litestar: ${JSON.stringify(d.litestar)?.slice(0, 140)}`)
  }
  if (f.diffs.length > 6) console.log(`   …另有 ${f.diffs.length - 6} 处`)
}

console.log(`\n${failures.length === 0 ? '✅' : '💥'} ${pass}/${cases.length} 个用例与 Litestar 一致`)
process.exit(failures.length === 0 ? 0 : 1)
