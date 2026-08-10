/**
 * Worker 对拍：新链路（TS 挑活 → cairnq → Python worker）算出来的东西，必须和
 * 旧路径（Python 进程内直接读库算）**逐位相同**。
 *
 *   pnpm parity:worker          # 需要 cairnq worker 在跑（just worker-dev）
 *
 * 为什么不拿库里存量当基准：silva head 的权重更新过，`post_aesthetic_scores` 里
 * 的历史分数是**旧权重**算的，和今天任何一条路径都对不上。基准必须是同一时刻的
 * 旧代码路径，所以这里现场起一个 Python 子进程算（`server/scripts/worker_direct.py`），
 * 而不是查表。
 *
 * 这个脚本是 Phase 5/6 每搬一个 worker 都要复用的形状：同一批输入，两条路径，
 * 逐位比对。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DEDUP_CHUNK_SIZE, DEDUP_THRESHOLD, dedupTask, embeddingTask, encodeVectorBlob, GPU_QUEUE, silvaTask, taggerTask, waifuTask } from '@pictoria/contracts'
import { assignFromPairs, createDb, exportVectorMatrix, fetchEmbeddingBlobs, listEmbeddingPending, listTaggerPending, listWaifuPending, runMigrations } from '@pictoria/db'
import { CairnQ } from 'cairnq'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SAMPLE = 12

const fsExists = (p: string) => fs.existsSync(p)

const { sqlite } = createDb({ path: path.resolve(ROOT, 'server/illustration/images/.pictoria/pictoria.sqlite') })

/** 旧路径：Python 进程内直接读库算。返回值形状随 worker 而定。 */
function workerDirect(scorer: string, postIds: number[], extra: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', 'python', 'scripts/worker_direct.py'], {
      cwd: path.resolve(ROOT, 'server'),
      shell: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('close', (code) => {
      if (code !== 0)
        return reject(new Error(`worker_direct.py 退出 ${code}: ${err.slice(-500)}`))
      try {
        resolve(JSON.parse(out))
      }
      catch {
        reject(new Error(`worker_direct.py 输出不是 JSON: ${out.slice(0, 300)}`))
      }
    })
    child.stdin.end(JSON.stringify({ scorer, postIds, ...extra }))
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

  const direct = (await workerDirect(scorer, ids)).scores
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

  const direct = (await workerDirect('waifu', imgRows.map(r => r.id))).scores
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

// ─── tagger：算在 Python，落库在 TS ────────────────────────────────
{
  const rows = sqlite
    .prepare<[], { id: number, full_path: string }>(
      `SELECT p.id, p.full_path FROM posts p `
      + `WHERE LOWER(p.extension) IN ('jpg','jpeg','png','webp') ORDER BY RANDOM() LIMIT 4`,
    )
    .all()
  const root = path.resolve(ROOT, 'server/illustration/images')
  const tagItems = rows.map(r => ({ postId: r.id, path: `${root}/${r.full_path}` }))

  const t0 = Date.now()
  const viaQueue = await tasks.call(taggerTask, { items: tagItems }, {
    queue: GPU_QUEUE,
    key: `parity:tagger:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 300_000,
    pollMs: 100,
  })
  console.log(`tagger: 队列往返 ${Date.now() - t0} ms，${viaQueue.results.length} 条`)

  const direct: any[] = (await workerDirect('tagger', rows.map(r => r.id))).results
  const directMap = new Map(direct.map(d => [d.postId, d]))
  let bad = 0
  for (const r of viaQueue.results) {
    const d = directMap.get(r.postId)
    // 标签集合与顺序都要一样：顺序是模型按置信度排的，落库时不重排，
    // 所以它也是契约的一部分。
    if (!d
      || JSON.stringify(d.generalTags) !== JSON.stringify(r.generalTags)
      || JSON.stringify(d.characterTags) !== JSON.stringify(r.characterTags)
      || d.rating !== r.rating) {
      bad++
      if (bad <= 2)
        fails.push(`tagger post ${r.postId}: 队列 ${JSON.stringify(r).slice(0, 160)} vs 直算 ${JSON.stringify(d).slice(0, 160)}`)
    }
  }
  if (bad)
    fails.push(`tagger: ${bad}/${viaQueue.results.length} 条不一致`)
  else
    pass += viaQueue.results.length

  // 待办查询拼出来的路径必须真实存在（和 waifu 同款检查，但走的是另一条 SQL）
  const pending = listTaggerPending(sqlite, root, 3)
  const broken = pending.filter(p => !fsExists(p.path))
  if (!broken.length)
    pass++
  else fails.push(`tagger 待办查询拼出了不存在的路径：${broken.map(b => b.path).join(', ')}`)
}

// ─── embedding：向量必须逐字节相同 ────────────────────────────────
{
  const rows = sqlite
    .prepare<[], { id: number, full_path: string }>(
      `SELECT p.id, p.full_path FROM posts p `
      + `WHERE LOWER(p.extension) IN ('jpg','jpeg','png','webp') ORDER BY RANDOM() LIMIT 3`,
    )
    .all()
  const root = path.resolve(ROOT, 'server/illustration/images')
  const embItems = rows.map(r => ({ postId: r.id, path: `${root}/${r.full_path}` }))

  const t0 = Date.now()
  const viaQueue = await tasks.call(embeddingTask, { items: embItems }, {
    queue: GPU_QUEUE,
    key: `parity:embedding:${Date.now()}`,
    conflict: 'reject',
    waitTimeoutMs: 300_000,
    pollMs: 100,
  })
  console.log(`embedding: 队列往返 ${Date.now() - t0} ms，${viaQueue.embeddings.length} 条`)

  const direct: any[] = (await workerDirect('embedding', rows.map(r => r.id))).embeddings
  const directMap = new Map(direct.map(d => [d.postId, d.embedding]))
  let bad = 0
  for (const e of viaQueue.embeddings) {
    // base64 逐字符相同 ⇒ float32 逐位相同。向量是检索的地基，末位漂移会让
    // KNN 的邻居顺序变化，而那种不一致查起来最要命。
    if (directMap.get(e.postId) !== e.embedding) {
      bad++
      if (bad <= 2)
        fails.push(`embedding post ${e.postId}: 队列与直算的向量不同`)
    }
    // 尺寸也钉一下：1152 维 float32 → 4608 字节 → base64 6144 字符
    if (e.embedding.length !== 6144)
      fails.push(`embedding post ${e.postId}: base64 长度 ${e.embedding.length}，应为 6144`)
  }
  if (bad)
    fails.push(`embedding: ${bad}/${viaQueue.embeddings.length} 条不一致`)
  else
    pass += viaQueue.embeddings.length

  const pending = listEmbeddingPending(sqlite, root, 3)
  const broken = pending.filter(p => !fsExists(p.path))
  if (!broken.length)
    pass++
  else fails.push(`embedding 待办查询拼出了不存在的路径：${broken.map(b => b.path).join(', ')}`)
}

// ─── dedup：唯一一个输入走文件的任务 ──────────────────────────────
{
  // 取样必须**含近重复**，否则两条路径都返回空对，比对通过但什么也没证明。
  // 库里现成的分组就是已知的近重复簇 —— 拿几个组的全部成员，再随机填一些
  // 无关的当噪声，构成一个既有真对、又有真非对的输入。
  const groups = sqlite
    .prepare<[], { canonical_post_id: number }>(
      `SELECT canonical_post_id FROM posts WHERE canonical_post_id IS NOT NULL `
      + `GROUP BY canonical_post_id ORDER BY RANDOM() LIMIT 8`,
    )
    .all()
    .map(r => r.canonical_post_id)
  const members = groups.length
    ? sqlite
        .prepare<number[], { id: number }>(
          `SELECT id FROM posts WHERE id IN (${groups.map(() => '?').join(',')}) `
          + `OR canonical_post_id IN (${groups.map(() => '?').join(',')})`,
        )
        .all(...groups, ...groups)
        .map(r => r.id)
    : []
  const noise = sqlite
    .prepare<[number], { post_id: number }>(
      `SELECT post_id FROM post_vectors_siglip2 ORDER BY RANDOM() LIMIT ?`,
    )
    .all(200)
    .map(r => r.post_id)
  const sampleIds = [...new Set([...members, ...noise])].sort((a, b) => a - b)

  // 导出用的是**生产那个函数**，不是脚本里另写一份 —— 这个文件的字节布局正是
  // 跨语言契约本身。给它一个只装了取样向量的临时库，就能不改生产代码地跑子集。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-dedup-parity-'))
  const tmp = createDb({ path: path.join(tmpDir, 'subset.sqlite') })
  runMigrations(tmp.sqlite, path.resolve(ROOT, 'server/migrations'))
  const blobRows = sqlite
    .prepare<number[], { post_id: number, embedding: Buffer }>(
      `SELECT post_id, embedding FROM post_vectors_siglip2 WHERE post_id IN (${sampleIds.map(() => '?').join(',')})`,
    )
    .all(...sampleIds)
  const ins = tmp.sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)')
  tmp.sqlite.transaction(() => {
    for (const r of blobRows) ins.run(BigInt(r.post_id), r.embedding)
  })()

  // 文件必须落在图库根之内 —— worker 的 _resolve_inside 挡在外面的路径
  const root = path.resolve(ROOT, 'server/illustration/images')
  const matrixFile = path.join(root, '.pictoria', 'parity-dedup.f32')
  const { ids, count, dim } = exportVectorMatrix(tmp.sqlite, matrixFile)
  tmp.sqlite.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`dedup: 取样 ${count} 条（${members.length} 条来自已知分组），矩阵 ${(count * dim * 4 / 1e6).toFixed(1)} MB`)

  try {
    const t0 = Date.now()
    const viaQueue = await tasks.call(dedupTask, {
      matrixPath: matrixFile,
      count,
      dim,
      threshold: DEDUP_THRESHOLD,
      chunkSize: DEDUP_CHUNK_SIZE,
    }, {
      queue: GPU_QUEUE,
      key: `parity:dedup:${Date.now()}`,
      conflict: 'reject',
      waitTimeoutMs: 600_000,
      pollMs: 100,
    })
    console.log(`dedup: 队列往返 ${Date.now() - t0} ms，${viaQueue.pairs.length} 对近邻`)

    const direct = await workerDirect('dedup', sampleIds, {
      threshold: DEDUP_THRESHOLD,
      chunkSize: DEDUP_CHUNK_SIZE,
    })

    // 前提：两侧看到的是同一批 id、同一个行序。不成立的话下面的下标比对没有意义。
    if (JSON.stringify(ids) === JSON.stringify(direct.ids))
      pass++
    else fails.push(`dedup: 两侧的 id 顺序不同（${ids.length} vs ${direct.ids.length}）`)

    // 邻接对逐个相同 —— 这是矩阵乘 + 文件读的联合结论
    const mine = JSON.stringify([...viaQueue.pairs].map(p => [p[0], p[1]]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!))
    const theirs = JSON.stringify(direct.pairs)
    if (mine === theirs)
      pass++
    else fails.push(`dedup: 邻接对不同，队列 ${viaQueue.pairs.length} 对，直算 ${direct.pairs.length} 对`)

    // 贪心分配（这一段在 TS，旧路径里在 Python）必须给出同一份 (成员, canonical)
    const assignments = assignFromPairs(ids, viaQueue.pairs).sort((a, b) => a[0]! - b[0]!)
    if (JSON.stringify(assignments) === JSON.stringify(direct.assignments))
      pass++
    else fails.push(`dedup: 分组结果不同
   TS  ${JSON.stringify(assignments).slice(0, 300)}
   PY  ${JSON.stringify(direct.assignments).slice(0, 300)}`)

    // 取样里既然含已知分组，就必须真的归出组来 —— 否则上面三项全"通过"，
    // 而它们比对的是两个空结果，什么也没证明。
    if (!members.length || assignments.length)
      pass++
    else fails.push('dedup: 取样里有已知分组，却一个成员都没归组 —— 对拍等于空跑')
  }
  finally {
    fs.rmSync(matrixFile, { force: true })
  }
}

await tasks.close()
sqlite.close()

for (const f of fails) console.log(`❌ ${f}`)
console.log(`\n${fails.length === 0 ? '✅' : '💥'} ${pass} 项 worker 对拍通过（新链路与旧路径逐位相同）`)
process.exit(fails.length === 0 ? 0 : 1)
