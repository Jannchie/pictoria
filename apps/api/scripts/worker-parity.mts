/**
 * Worker 对拍：新链路（TS 挑活 → cairnq → Python worker）算出来的东西，必须和
 * 旧路径（Python 进程内直接读库算）**逐位相同**。
 *
 *   pnpm parity:worker          # 需要 cairnq worker 在跑（just worker-dev）
 *
 * 为什么不拿库里存量当基准：silva head 的权重更新过，`post_aesthetic_scores` 里
 * 的历史分数是**旧权重**算的，和今天任何一条路径都对不上。基准必须是同一时刻的
 * 旧代码路径，所以这里现场起一个 Python 子进程算（`server/scripts/score_direct.py`），
 * 而不是查表。
 *
 * 这个脚本是 Phase 5/6 每搬一个 worker 都要复用的形状：同一批输入，两条路径，
 * 逐位比对。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { encodeVectorBlob, GPU_QUEUE, silvaTask, waifuTask } from '@pictoria/contracts'
import { createDb, fetchEmbeddingBlobs, listWaifuPending } from '@pictoria/db'
import { CairnQ } from 'cairnq'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SAMPLE = 12

const fsExists = (p: string) => fs.existsSync(p)

const { sqlite } = createDb({ path: path.resolve(ROOT, 'server/illustration/images/.pictoria/pictoria.sqlite') })

/** 旧路径：Python 进程内直接读库算。 */
function scoreDirect(scorer: string, postIds: number[]): Promise<Array<{ postId: number, score: number }>> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', 'python', 'scripts/score_direct.py'], {
      cwd: path.resolve(ROOT, 'server'),
      shell: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('close', (code) => {
      if (code !== 0)
        return reject(new Error(`score_direct.py 退出 ${code}: ${err.slice(-500)}`))
      try {
        resolve(JSON.parse(out).scores)
      }
      catch {
        reject(new Error(`score_direct.py 输出不是 JSON: ${out.slice(0, 300)}`))
      }
    })
    child.stdin.end(JSON.stringify({ scorer, postIds }))
  })
}

const fails: string[] = []
let pass = 0

// 随机取样而不是取前 N 个：固定的前几行会一直落在同一片向量上，一整类输入
// （比如全黑图、极端长宽比）可能永远测不到。
const ids = sqlite
  .prepare<[number], { post_id: number }>(
    `SELECT post_id FROM post_vectors_siglip2 ORDER BY RANDOM() LIMIT ?`,
  )
  .all(SAMPLE)
  .map(r => r.post_id)
  .sort((a, b) => a - b)

const blobs = fetchEmbeddingBlobs(sqlite, ids)
const items = ids.filter(id => blobs.has(id)).map(id => ({ postId: id, embedding: encodeVectorBlob(blobs.get(id)!) }))
console.log(`取样 ${items.length} 条，payload ${(JSON.stringify(items).length / 1024).toFixed(1)} KB`)

const tasks = CairnQ.sqlite(path.resolve(ROOT, 'server/illustration/images/.pictoria/tasks.sqlite'))
await tasks.connect()

for (const scorer of ['silva', 'silva_luna'] as const) {
  const t0 = Date.now()
  let viaQueue
  try {
    viaQueue = await tasks.call(silvaTask, { scorer, items }, {
      queue: GPU_QUEUE,
      key: `parity:${scorer}:${ids[0]}:${Date.now()}`,
      conflict: 'reject',
      waitTimeoutMs: 300_000,
      pollMs: 100,
    })
  }
  catch (err) {
    fails.push(`${scorer}: cairnq 往返失败 —— worker 在跑吗？（just worker-dev）\n   ${String(err)}`)
    continue
  }
  const elapsed = Date.now() - t0

  const direct = await scoreDirect(scorer, ids)
  const directMap = new Map(direct.map(d => [d.postId, d.score]))

  if (viaQueue.scores.length !== direct.length) {
    fails.push(`${scorer}: 条数不同，队列 ${viaQueue.scores.length} 直算 ${direct.length}`)
    continue
  }

  let bad = 0
  for (const s of viaQueue.scores) {
    // 逐位，不是近似：两侧跑的是同一个 head、同一个设备、同一批输入字节，
    // 任何差异都说明编码或顺序有一处不对，而不是浮点噪声。
    if (directMap.get(s.postId) !== s.score) {
      bad++
      if (bad <= 3)
        fails.push(`${scorer} post ${s.postId}: 队列 ${s.score} vs 直算 ${directMap.get(s.postId)}`)
    }
  }
  if (bad)
    fails.push(`${scorer}: ${bad}/${viaQueue.scores.length} 条不一致`)
  else
    pass += viaQueue.scores.length

  console.log(`${scorer}: 队列往返 ${elapsed} ms，${viaQueue.scores.length} 条`)
}

// 顺序也是契约的一部分：结果按 payload 的 items 顺序回来，落库时不重排。
for (const scorer of ['silva'] as const) {
  const r = await tasks.call(silvaTask, { scorer, items: items.slice(0, 4) }, {
    queue: GPU_QUEUE,
    key: `parity:order:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 300_000,
    pollMs: 100,
  })
  const got = r.scores.map(s => s.postId)
  const want = items.slice(0, 4).map(i => i.postId)
  if (JSON.stringify(got) === JSON.stringify(want))
    pass++
  else fails.push(`结果顺序与 payload 不同：${got} vs ${want}`)
}

// 空批次不该加载 ML 栈，也不该失败
{
  const r = await tasks.call(silvaTask, { scorer: 'silva', items: [] }, {
    queue: GPU_QUEUE,
    key: `parity:empty:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 60_000,
    pollMs: 100,
  })
  if (r.scores.length === 0)
    pass++
  else fails.push(`空批次返回了 ${r.scores.length} 条`)
}

// 未注册的 scorer 必须被 worker 拒绝 —— payload 跨进程边界，它是输入不是常量
{
  try {
    await tasks.call(silvaTask, { scorer: 'bogus' as never, items: items.slice(0, 1) }, {
      queue: GPU_QUEUE,
      key: `parity:bogus:${Date.now()}`,
      conflict: 'reject',
      waitTimeoutMs: 60_000,
      pollMs: 100,
      maxAttempts: 1,
    })
    fails.push('未注册的 scorer 被接受了')
  }
  catch {
    pass++
  }
}

// ─── waifu：输入是图片本身，失败是正常结果 ────────────────────────
{
  // 从库里现成的行拿绝对路径 —— 和调度器用的是同一个函数，所以路径的拼法本身
  // 也在对拍范围内。挑已经打过分的（listWaifuPending 只给没打分的），所以这里
  // 自己查。
  const imgRows = sqlite
    .prepare<[], { id: number, full_path: string }>(
      `SELECT p.id, p.full_path FROM posts p JOIN post_waifu_scores w ON w.post_id = p.id `
      + `WHERE LOWER(p.extension) IN ('jpg','jpeg','png','webp') ORDER BY RANDOM() LIMIT 6`,
    )
    .all()
  const root = path.resolve(ROOT, 'server/illustration/images')
  const imgItems = imgRows.map(r => ({ postId: r.id, path: `${root}/${r.full_path}` }))

  const t0 = Date.now()
  const viaQueue = await tasks.call(waifuTask, { items: imgItems }, {
    queue: GPU_QUEUE,
    key: `parity:waifu:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 300_000,
    pollMs: 100,
  })
  console.log(`waifu: 队列往返 ${Date.now() - t0} ms，${viaQueue.scores.length} 条打分 / ${viaQueue.failures.length} 条失败`)

  const direct = await scoreDirect('waifu', imgRows.map(r => r.id))
  const directMap = new Map(direct.map(d => [d.postId, d.score]))
  let bad = 0
  for (const s of viaQueue.scores) {
    if (directMap.get(s.postId) !== s.score) {
      bad++
      if (bad <= 3)
        fails.push(`waifu post ${s.postId}: 队列 ${s.score} vs 直算 ${directMap.get(s.postId)}`)
    }
  }
  if (bad)
    fails.push(`waifu: ${bad}/${viaQueue.scores.length} 条不一致`)
  else
    pass += viaQueue.scores.length

  // 路径逃逸必须被 worker 拒绝，而不是当成一张读不出来的图默默拉黑。payload 穿过
  // 进程边界，路径是输入。
  const escaped = await tasks.call(waifuTask, {
    items: [{ postId: -1, path: path.resolve(ROOT, 'package.json') }],
  }, {
    queue: GPU_QUEUE,
    key: `parity:escape:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 60_000,
    pollMs: 100,
  })
  if (escaped.failures.length === 1 && escaped.failures[0]!.error.includes('escapes'))
    pass++
  else fails.push(`路径逃逸没有被拒：${JSON.stringify(escaped)}`)

  // 不存在的文件被丢掉而不是拉黑 —— 它不是坏数据，它是没了
  const missing = await tasks.call(waifuTask, {
    items: [{ postId: -1, path: `${root}/__does_not_exist__.jpg` }],
  }, {
    queue: GPU_QUEUE,
    key: `parity:missing:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 60_000,
    pollMs: 100,
  })
  if (missing.scores.length === 0 && missing.failures.length === 0)
    pass++
  else fails.push(`文件不存在时的处理不对：${JSON.stringify(missing)}`)

  // 调度器用的待办查询本身：拼出来的路径必须真的存在
  const pending = listWaifuPending(sqlite, root, 3)
  const broken = pending.filter(p => !fsExists(p.path))
  if (!broken.length)
    pass++
  else fails.push(`待办查询拼出了不存在的路径：${broken.map(b => b.path).join(', ')}`)
}

await tasks.close()
sqlite.close()

for (const f of fails) console.log(`❌ ${f}`)
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项 worker 对拍通过（新链路与旧路径逐位相同）`)
process.exit(fails.length === 0 ? 0 : 1)
