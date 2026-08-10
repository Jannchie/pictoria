#!/usr/bin/env node
// openapi-contract-diff.mjs 的黑盒自测。
//
//   node scripts/openapi-contract-diff.test.mjs
//
// 存在的理由：这个脚本是 Litestar → Hono 迁移期间"前端不会坏"的唯一保证，
// 而它自己曾经有过一个静默漏报的 bug —— IGNORED_KEYS 里的 description/tags
// 同时是 OpenAPI 关键字和真实字段名，不分层级过滤就会把 PostDetailPublic 的
// `description` / `tags` 两个业务字段跳过。假阳性只是烦人，漏报是会放行事故的。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIFF = new URL('./openapi-contract-diff.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oadiff-'))

const doc = (schema, opts = {}) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/v2/things': {
      post: {
        operationId: opts.operationId ?? 'v2GetThing',
        ...(opts.dropBody ? {} : { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } }),
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } },
      },
    },
    ...(opts.dropPath ? {} : { '/v2/others': { get: { operationId: 'v2GetOther', responses: { 200: { description: 'ok' } } } } }),
  },
  components: { schemas: { Thing: schema } },
})

const BASE = doc({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    // 故意用 OpenAPI 关键字当字段名 —— 这正是漏报 bug 的触发条件
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    nullableList: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
  },
  required: ['id', 'description'],
})

let pass = 0
let fail = 0

function check(name, candidate, shouldDiffer) {
  const a = path.join(tmp, 'a.json')
  const b = path.join(tmp, 'b.json')
  fs.writeFileSync(a, JSON.stringify(BASE))
  fs.writeFileSync(b, JSON.stringify(candidate))
  const r = spawnSync(process.execPath, [DIFF, a, b], { encoding: 'utf8' })
  const differed = r.status !== 0
  const ok = differed === shouldDiffer
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  —— 期望${shouldDiffer ? '报告差异' : '判定一致'}，实际相反`}`)
  if (!ok) {
    fail++
    console.log(r.stdout.split('\n').filter((l) => l.trim()).slice(0, 6).map((l) => `        ${l}`).join('\n'))
  } else pass++
}

const clone = (o) => JSON.parse(JSON.stringify(o))

console.log('必须报告差异的（漏报 = 放行事故）：')

check('operationId 改名', doc(clone(BASE.components.schemas.Thing), { operationId: 'v2GetThingById' }), true)
check('端点消失', doc(clone(BASE.components.schemas.Thing), { dropPath: true }), true)
check('requestBody 消失', doc(clone(BASE.components.schemas.Thing), { dropBody: true }), true)

{
  const s = clone(BASE.components.schemas.Thing)
  s.properties.description = { type: 'integer' } // 回归：字段名恰好叫 description
  check('名为 description 的业务字段改类型', doc(s), true)
}
{
  const s = clone(BASE.components.schemas.Thing)
  delete s.properties.tags // 回归：字段名恰好叫 tags
  check('名为 tags 的业务字段被删', doc(s), true)
}
{
  const s = clone(BASE.components.schemas.Thing)
  s.properties.title = { type: 'integer' } // 回归：字段名恰好叫 title
  check('名为 title 的业务字段改类型', doc(s), true)
}
{
  const s = clone(BASE.components.schemas.Thing)
  s.required = ['id'] // 少一个必填
  check('required 少一项', doc(s), true)
}
{
  const s = clone(BASE.components.schemas.Thing)
  s.properties.extra = { type: 'string' }
  check('多出一个字段', doc(s), true)
}

console.log('\n必须判定一致的（假阳性会淹没真信号）：')

check('完全相同', clone(BASE), false)
{
  const s = clone(BASE.components.schemas.Thing)
  // zod 方言：type 数组 vs Pydantic 的 oneOf+null
  s.properties.nullableList = { type: ['array', 'null'], items: { type: 'string' } }
  check('nullable 方言差异 (oneOf+null ↔ type 数组)', doc(s), false)
}
{
  const s = clone(BASE.components.schemas.Thing)
  s.required = ['description', 'id'] // 顺序不同
  check('required 顺序不同', doc(s), false)
}
{
  const s = clone(BASE.components.schemas.Thing)
  s.description = '两个框架的措辞不可能一致'
  s.title = 'SomeOtherTitle'
  check('schema 级 description/title 文字差异', doc(s), false)
}
{
  const d = doc(clone(BASE.components.schemas.Thing))
  d.paths['/v2/things'].post.description = '换个说法'
  d.paths['/v2/things'].post.tags = ['posts']
  check('操作级 description/tags 差异', d, false)
}

{
  const s = clone(BASE.components.schemas.Thing)
  // 三分支联合：Pydantic 写 oneOf，zod 写 anyOf，语义相同
  s.properties.sortish = { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] }
  const a = doc(s)
  const s2 = clone(s)
  s2.properties.sortish = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }
  const b = doc(s2)
  // 直接两两比：BASE 不含这个字段，所以单独构造一对
  fs.writeFileSync(path.join(tmp, 'x.json'), JSON.stringify(a))
  fs.writeFileSync(path.join(tmp, 'y.json'), JSON.stringify(b))
  const r = spawnSync(process.execPath, [DIFF, path.join(tmp, 'x.json'), path.join(tmp, 'y.json')], { encoding: 'utf8' })
  const ok = r.status === 0
  console.log(`  ${ok ? '✅' : '❌'} 三分支联合 oneOf ↔ anyOf 视为一致`)
  if (ok) pass++
  else { fail++; console.log(r.stdout.split(String.fromCharCode(10)).slice(0, 8).map((l) => `        ${l}`).join(String.fromCharCode(10))) }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅' : '💥'} ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
