#!/usr/bin/env node
// OpenAPI 契约比对 —— Litestar → Hono 迁移期间的安全网。
//
// 前端 24k 行代码调的是 `v2SearchPosts` / `v2GetPostsCount` 这类由 Litestar 的
// default_operation_id_creator 拼出来的名字，字段是 snake_case（PydanticPlugin
// prefer_alias=True）。迁移后这些必须逐字不变，否则 `pnpm genapi` 会产出一份
// 名字对不上的客户端，而 TS 编译错误会淹没在 100 个 rename 里。
//
//   node scripts/openapi-contract-diff.mjs docs/openapi.baseline.json http://127.0.0.1:4777/schema/openapi.json
//
// 比对的是**结构**而非字节：description/title/example 这类文字差异忽略，
// 因为两个框架的措辞不可能一致；type/format/enum/required/properties/$ref 展开后
// 的形状必须一致。差异非空 → 退出码 1。
import fs from 'node:fs'

const IGNORED_KEYS = new Set([
  'description', 'title', 'summary', 'example', 'examples',
  'externalDocs', 'tags', 'operationId', 'x-codegen-request-body-name',
])

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`拉取 ${src} 失败: HTTP ${res.status}`)
    return res.json()
  }
  return JSON.parse(fs.readFileSync(src, 'utf8'))
}

// 把 $ref 递归展开成结构指纹。schema 名字本身不参与比较（两边命名规则必然不同），
// 但循环引用要留标记，否则无限递归。
//
// ⚠️ `inProperties` 不是可选的优雅：IGNORED_KEYS 里的 description/tags/title 既是
// OpenAPI 关键字，**也是这个 API 里真实存在的字段名**（PostDetailPublic 同时有
// `description` 和 `tags` 两个业务字段）。不区分层级就会把它们连同注释一起跳过，
// 于是字段增删改全部漏报 —— 安全网上一个正对着最大那张表的洞。
function fingerprint(node, doc, seen = new Set(), inProperties = false) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => fingerprint(n, doc, seen, false))

  if (typeof node.$ref === 'string') {
    const ref = node.$ref
    if (seen.has(ref)) return `«circular»`
    const target = ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], doc)
    if (target === undefined) return `«missing-ref:${ref}»`
    return fingerprint(target, doc, new Set([...seen, ref]), false)
  }

  const out = {}
  for (const key of Object.keys(node).sort()) {
    // 在 properties 对象内部，key 是字段名，不是关键字 —— 一个都不能丢
    if (!inProperties && IGNORED_KEYS.has(key)) continue
    out[key] = fingerprint(node[key], doc, seen, key === 'properties')
  }
  return out
}

// Litestar/Pydantic 和 zod 表达"可空"的方言不同，但语义等价，经 hey-api 后
// 产出的 TS 类型逐字相同（实测 PostFilter：两边都是 `rating?: Array<number> | null`）。
// 不归一化的话 Phase 4 会淹没在假阳性里，安全网就废了。
//
//   Pydantic : {oneOf: [{type:'array', items:…}, {type:'null'}]}
//   zod v4   : {type: ['array','null'], items:…}
//   规范形式 : {type:'array', items:…, 'x-nullable': true}
//
// default 同理：Pydantic 在 oneOf 分支内和外层各放一份，zod 只放一处 —— 提升到外层。
function canonicalize(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(canonicalize)

  const out = {}
  for (const [k, v] of Object.entries(node)) out[k] = canonicalize(v)

  // `required` 是集合不是序列：Pydantic 按字母序、zod 按声明序，语义相同。
  // 空数组与整个键缺失也等价（zod 的 .partial() 干脆不输出这个键）。
  if (Array.isArray(out.required) && out.required.every((x) => typeof x === 'string')) {
    if (out.required.length === 0) delete out.required
    else out.required = [...out.required].sort()
  }

  // 形式 A: oneOf/anyOf 中恰好一支是 null
  for (const kw of ['oneOf', 'anyOf']) {
    const branches = out[kw]
    if (!Array.isArray(branches)) continue
    const nulls = branches.filter((b) => b && b.type === 'null')
    const rest = branches.filter((b) => !(b && b.type === 'null'))
    if (nulls.length !== 1 || rest.length !== 1) continue
    const { [kw]: _drop, ...outer } = out
    const merged = { ...rest[0], ...outer, 'x-nullable': true }
    if (rest[0].default !== undefined && merged.default === undefined) merged.default = rest[0].default
    return merged
  }

  // 形式 B: type 是数组且含 'null'
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const rest = out.type.filter((t) => t !== 'null')
    return { ...out, type: rest.length === 1 ? rest[0] : rest, 'x-nullable': true }
  }

  return out
}

// 一个操作压成可比较的形状。参数按 (in,name) 排序，消除声明顺序噪音。
function normalizeOperation(op, doc) {
  const params = (op.parameters ?? [])
    .map((p) => {
      const r = canonicalize(fingerprint(p, doc))
      return { name: r.name, in: r.in, required: r.required ?? false, schema: r.schema }
    })
    .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
  // 按 (in, name) 键成对象而不是留成数组：数组只能整体报"不一样"，键成对象后
  // deepDiff 能一路指到 params.query:limit.schema.x-nullable。
  const paramsByKey = Object.fromEntries(params.map(p => [`${p.in}:${p.name}`, p]))

  const body = op.requestBody
    ? {
        required: fingerprint(op.requestBody, doc).required ?? false,
        content: Object.fromEntries(
          Object.entries(op.requestBody.content ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ct, v]) => [ct, canonicalize(fingerprint(v.schema, doc))]),
        ),
      }
    : null

  const responses = Object.fromEntries(
    Object.entries(op.responses ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, v]) => [
        status,
        Object.fromEntries(
          Object.entries(v.content ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ct, c]) => [ct, canonicalize(fingerprint(c.schema, doc))]),
        ),
      ]),
  )

  return { operationId: op.operationId ?? null, params: paramsByKey, body, responses }
}

function indexOperations(doc) {
  const out = new Map()
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) out.set(`${method.toUpperCase()} ${path}`, normalizeOperation(item[method], doc))
    }
  }
  return out
}

// 结构化 diff，路径可读（例如 responses.200.application/json.properties.rating）
function deepDiff(a, b, path = '', out = []) {
  const j = (v) => JSON.stringify(v)
  if (j(a) === j(b)) return out
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(a) || !isObj(b)) {
    out.push({ path: path || '(根)', baseline: a, candidate: b })
    return out
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push({ path: `${path}.${k}`.replace(/^\./, ''), baseline: '«缺失»', candidate: b[k] })
    else if (!(k in b)) out.push({ path: `${path}.${k}`.replace(/^\./, ''), baseline: a[k], candidate: '«缺失»' })
    else deepDiff(a[k], b[k], `${path}.${k}`.replace(/^\./, ''), out)
  }
  return out
}

const trunc = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s == null ? String(s) : s.length > n ? `${s.slice(0, n)}…` : s
}

const [, , baselineSrc, candidateSrc] = process.argv
if (!baselineSrc || !candidateSrc) {
  console.error('用法: node scripts/openapi-contract-diff.mjs <baseline.json> <candidate.json|url>')
  process.exit(2)
}

const [baselineDoc, candidateDoc] = await Promise.all([load(baselineSrc), load(candidateSrc)])
const baseline = indexOperations(baselineDoc)
const candidate = indexOperations(candidateDoc)

const missing = [...baseline.keys()].filter((k) => !candidate.has(k))
const added = [...candidate.keys()].filter((k) => !baseline.has(k))
const shared = [...baseline.keys()].filter((k) => candidate.has(k))

const renamed = []
const changed = []
for (const key of shared) {
  const a = baseline.get(key)
  const b = candidate.get(key)
  if (a.operationId !== b.operationId) renamed.push({ key, from: a.operationId, to: b.operationId })
  const diffs = deepDiff(
    { params: a.params, body: a.body, responses: a.responses },
    { params: b.params, body: b.body, responses: b.responses },
  )
  if (diffs.length) changed.push({ key, operationId: a.operationId, diffs })
}

console.log(`baseline : ${baselineSrc}  (${baseline.size} 个操作)`)
console.log(`candidate: ${candidateSrc}  (${candidate.size} 个操作)`)
console.log('')

if (missing.length) {
  console.log(`❌ 未实现 (${missing.length}) —— baseline 有、candidate 没有：`)
  for (const k of missing) console.log(`   ${k}   [${baseline.get(k).operationId}]`)
  console.log('')
}
if (renamed.length) {
  console.log(`❌ operationId 变了 (${renamed.length}) —— 这会直接打断前端调用：`)
  for (const r of renamed) console.log(`   ${r.key}\n     baseline : ${r.from}\n     candidate: ${r.to}`)
  console.log('')
}
if (changed.length) {
  console.log(`❌ schema 结构变了 (${changed.length})：`)
  for (const c of changed) {
    console.log(`   ${c.key}   [${c.operationId}]`)
    for (const d of c.diffs.slice(0, 8)) {
      console.log(`     ${d.path}`)
      console.log(`       baseline : ${trunc(d.baseline)}`)
      console.log(`       candidate: ${trunc(d.candidate)}`)
    }
    if (c.diffs.length > 8) console.log(`     …另有 ${c.diffs.length - 8} 处`)
  }
  console.log('')
}
if (added.length) {
  console.log(`ℹ️  新增 (${added.length}) —— candidate 独有，不算失败：`)
  for (const k of added) console.log(`   ${k}   [${candidate.get(k).operationId}]`)
  console.log('')
}

const failures = missing.length + renamed.length + changed.length
if (failures === 0) {
  console.log(`✅ 契约一致：${shared.length} 个操作的 operationId 与请求/响应结构逐项相同`)
  process.exit(0)
}
console.log(`💥 ${failures} 处不一致（未实现 ${missing.length} / 改名 ${renamed.length} / 结构 ${changed.length}）`)
process.exit(1)
