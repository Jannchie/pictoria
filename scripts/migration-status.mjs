#!/usr/bin/env node
// 迁移进度：把 baseline 里的 70 个端点逐个问一遍，看它落在 Hono 还是仍被代理
// 转给 Litestar。
//
//   node scripts/migration-status.mjs
//
// 判据是代理加的 `x-pictoria-upstream` 响应头 —— 它只在请求真的被转发时出现。
// 这比数源码里的 `createRoute` 可靠：有几组路由是循环生成的，grep 会漏掉，而
// 这个是运行时事实。
//
// 探测请求**必须无副作用**，所以：只读端点直接问；写端点用不存在的 id 或空
// 列表（它们在业务逻辑里就返回 404 / 空操作，但代理该加的头照样加 —— 走不走
// 代理和请求成不成功是两件事）。真会干活的三个 command（sync-metadata /
// group-duplicates / db-snapshot）不发请求，靠源码判断。
const BASE = 'http://127.0.0.1:4777'

/** 不能发的：它们会真的干活。归属靠 `apps/api/src/routes/` 里有没有 cmd 路由判断。 */
const NEVER_PROBE = new Set([
  'POST /v2/cmd/sync-metadata',
  'POST /v2/cmd/group-duplicates',
  'POST /v2/cmd/db/snapshot',
])

/** 路径参数的替身。用不存在的 id，这样写端点探测完什么也没改。 */
const MISSING_ID = '999999999'

function fillParams(path) {
  return path
    .replace(/\{post_id\}/g, MISSING_ID)
    .replace(/\{queue_id\}/g, MISSING_ID)
    .replace(/\{annotation_id\}/g, MISSING_ID)
    .replace(/\{post_path\}/g, '__probe__.jpg')
    .replace(/\{folder_path\}/g, '__probe__')
    .replace(/\{name\}/g, '__probe__')
    .replace(/\{tag_name\}/g, '__probe__')
    .replace(/\{kind\}/g, 'absolute')
}

/** 让请求在业务逻辑里成为空操作的最小 body。 */
function bodyFor(method, path) {
  if (method === 'GET') return undefined
  if (path.includes('/bulk/') || path.endsWith('/posts/delete')) return { ids: [] }
  if (path.endsWith('/tags')) return { name_list: [] }
  if (path.includes('/annotations/undo')) return { kind: 'absolute', ids: [], session_id: '__probe__' }
  // 其余一律空对象：要么被 schema 校验拒，要么按空过滤器只读
  return {}
}

const doc = JSON.parse(
  await (await import('node:fs/promises')).readFile(new URL('../docs/openapi.baseline.json', import.meta.url), 'utf8'),
)

const cmdInHono = (await import('node:fs/promises'))
  .readdir(new URL('../apps/api/src/routes', import.meta.url))

const routeSrc = (await Promise.all(
  (await cmdInHono).map(f =>
    import('node:fs/promises').then(fs =>
      fs.readFile(new URL(`../apps/api/src/routes/${f}`, import.meta.url), 'utf8')),
  ),
)).join('\n')

const hono = []
const litestar = []
const errors = []

for (const [path, item] of Object.entries(doc.paths)) {
  for (const method of Object.keys(item)) {
    const key = `${method.toUpperCase()} ${path}`

    if (NEVER_PROBE.has(key)) {
      // 源码判断：routes/ 里根本没有 /v2/cmd 路由，所以它们必然还在 Litestar
      ;(routeSrc.includes(path) ? hono : litestar).push(key)
      continue
    }

    const body = bodyFor(method.toUpperCase(), path)
    const init = { method: method.toUpperCase() }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }

    try {
      const r = await fetch(BASE + fillParams(path), init)
      // 把响应体读干净，否则连接会挂着
      await r.arrayBuffer()
      ;(r.headers.has('x-pictoria-upstream') ? litestar : hono).push(key)
    }
    catch (err) {
      errors.push(`${key}: ${String(err)}`)
    }
  }
}

const total = hono.length + litestar.length
console.log(`\n已在 Hono: ${hono.length} / ${total}`)
console.log(`仍走 Litestar: ${litestar.length} / ${total}\n`)

const byGroup = new Map()
for (const key of litestar.sort()) {
  const group = key.split(' ')[1].split('/')[2] ?? '?'
  byGroup.set(group, [...(byGroup.get(group) ?? []), key])
}
for (const [group, keys] of [...byGroup].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${group} (${keys.length})`)
  for (const k of keys) console.log(`    ${k}`)
}

if (errors.length) {
  console.log('\n探测失败:')
  for (const e of errors) console.log(`  ${e}`)
}
console.log(
  litestar.length === 0
    ? '\n✅ 所有端点都在 Hono 上 —— 可以删掉 Litestar 和代理了'
    : `\n⏳ 还有 ${litestar.length} 个端点依赖 Litestar`,
)
