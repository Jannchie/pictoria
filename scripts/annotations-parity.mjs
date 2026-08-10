// annotations 对拍：提交 → 比对 → 立刻 undo 掉，两侧都不留痕。
const H = 'http://127.0.0.1:4777', L = 'http://127.0.0.1:4779'
const SESSION = 'parity-probe-session'

async function req(base, method, url, body) {
  const init = { method }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body) }
  const r = await fetch(base + url, init)
  const t = await r.text()
  let b = null; try { b = t ? JSON.parse(t) : null } catch { b = t }
  return { status: r.status, body: b }
}

let pass = 0; const fails = []
function cmp(label, a, b, { ignoreIds = false } = {}) {
  const norm = (x) => {
    if (!ignoreIds) return x
    const c = JSON.parse(JSON.stringify(x))
    if (c?.body?.ids) c.body.ids = c.body.ids.map(() => '<id>')
    return c
  }
  const x = JSON.stringify(norm(a)), y = JSON.stringify(norm(b))
  if (x === y) pass++
  else fails.push({ label, hono: x.slice(0, 200), litestar: y.slice(0, 200) })
}

const listed = await (await fetch(`${L}/v2/posts?limit=1`)).json()
const postId = listed.items[0].id

// 1) 校验失败：形状与状态码必须一致
for (const [label, url, body] of [
  ['absolute 维度非法', '/v2/annotations/absolute', { events: [{ post_id: postId, dimension: 'nope', scale: 5, value: 3, rubric_version: 'v1', session_id: SESSION }] }],
  ['absolute scale 非法', '/v2/annotations/absolute', { events: [{ post_id: postId, dimension: 'overall', scale: 4, value: 3, rubric_version: 'v1', session_id: SESSION }] }],
  ['absolute value 越界', '/v2/annotations/absolute', { events: [{ post_id: postId, dimension: 'overall', scale: 5, value: 9, rubric_version: 'v1', session_id: SESSION }] }],
  ['pairwise winner 非法', '/v2/annotations/pairwise', { post_a: postId, post_b: postId + 1, dimension: 'overall', winner: 'x', rubric_version: 'v1', session_id: SESSION }],
  ['content-flag 非法', '/v2/annotations/content-flag', { post_id: postId, flag: 'nope', session_id: SESSION }],
  ['undo kind 非法', '/v2/annotations/undo', { kind: 'nope', ids: [], session_id: SESSION }],
]) cmp(label, await req(H, 'POST', url, body), await req(L, 'POST', url, body))

cmp('count 维度非法', await req(H, 'GET', '/v2/annotations/pairwise/count?dimension=nope'), await req(L, 'GET', '/v2/annotations/pairwise/count?dimension=nope'))

// 2) 只读端点
for (const d of ['overall', 'color', 'finish', 'composition'])
  cmp(`count ${d}`, await req(H, 'GET', `/v2/annotations/pairwise/count?dimension=${d}`), await req(L, 'GET', `/v2/annotations/pairwise/count?dimension=${d}`))
cmp('count 默认维度', await req(H, 'GET', '/v2/annotations/pairwise/count'), await req(L, 'GET', '/v2/annotations/pairwise/count'))

for (const pid of [postId, 999999999])
  cmp(`post history ${pid}`, await req(H, 'GET', `/v2/annotations/post/${pid}`), await req(L, 'GET', `/v2/annotations/post/${pid}`))

// 3) 真实提交 → 比对 → undo（两侧各来一遍，各自清干净）
async function submitCycle(base) {
  const abs = await req(base, 'POST', '/v2/annotations/absolute', {
    events: [{ post_id: postId, dimension: 'overall', scale: 5, value: 4, rubric_version: 'probe', session_id: SESSION }],
  })
  const pw = await req(base, 'POST', '/v2/annotations/pairwise', {
    post_a: postId, post_b: postId + 1, dimension: 'overall', winner: 'a', rubric_version: 'probe', session_id: SESSION,
  })
  const flag = await req(base, 'POST', '/v2/annotations/content-flag', { post_id: postId, flag: 'love', session_id: SESSION })
  // 更正刚提交的 absolute
  const edit = await req(base, 'PATCH', `/v2/annotations/absolute/${abs.body.ids[0]}`, { verdict: 2 })
  // 清理：undo 两条可撤回的；flag 用 'none' 撤回
  const undoAbs = await req(base, 'POST', '/v2/annotations/undo', { kind: 'absolute', ids: abs.body.ids, session_id: SESSION })
  const undoPw = await req(base, 'POST', '/v2/annotations/undo', { kind: 'pairwise', ids: pw.body.ids, session_id: SESSION })
  await req(base, 'POST', '/v2/annotations/content-flag', { post_id: postId, flag: 'none', session_id: SESSION })
  return { abs, pw, flag, edit, undoAbs, undoPw }
}

const hCycle = await submitCycle(H)
const lCycle = await submitCycle(L)
for (const k of ['abs', 'pw', 'flag', 'edit', 'undoAbs', 'undoPw'])
  cmp(`提交周期 ${k}`, hCycle[k], lCycle[k], { ignoreIds: true })

// 4) 收尾确认：探针会话不该留下任何可撤回事件
const after = await req(L, 'GET', `/v2/annotations/post/${postId}`)
const leftover = [...after.body.absolute, ...after.body.pairwise].filter((a) => a.sessionId === SESSION)
if (leftover.length) fails.push({ label: '探针残留', hono: `${leftover.length} 条`, litestar: '0 条' })
else pass++

for (const f of fails) {
  console.log(`❌ ${f.label}`)
  console.log(`   hono    : ${f.hono}`)
  console.log(`   litestar: ${f.litestar}`)
}
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项 annotations 检查一致（探针数据已清理）`)
process.exit(fails.length === 0 ? 0 : 1)
