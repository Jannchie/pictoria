/**
 * 近重复分组的编排 —— 把导出、GPU、分配、落库串成一次重建。
 *
 * 这是唯一一个不走"一批 payload 进、一批结果出"形状的任务（见
 * `docs/refactor-monorepo-hono.md` §Phase 6 的"dedup 的形状问题"）：它要**全库**
 * 向量做一次分块 `X @ X.T`，1.0 GB 的输入塞不进一行 JSON。于是向量落地成一个临时
 * 文件，payload 只带路径；worker mmap 读、算、回传行下标对；分配和落库回到 TS。
 *
 * §D1 没有被破例：worker 依旧一行 SQL 都不碰，它只是从文件而不是 payload 里拿到
 * 那份它算不出来的输入。
 *
 * ## 判定是两级的
 *
 * SigLIP 2 回答的是"是不是同一个**主题**"。差分图要问的是"是不是同一张**画**"，
 * 这两个问题在 0.01（相似度 0.99）以内重合，再往外就分家了：只换表情、加了对白框、
 * 打了局部马赛克的差分落在 0.02–0.06 这一带，而"同画师同角色的另一张画"也落在这里。
 * 所以这一轮回传的对分两档：
 *
 *   * `dist ≤ DEDUP_THRESHOLD` —— 直接成边。这是原来那条路，行为不变。
 *   * 灰带（到 `DEDUP_GREY_THRESHOLD` 为止）—— 逐对送 LPIPS 仲裁（`lpipsVerifyTask`），
 *     它逐空间位置比 CNN 特征，所以只改了脸或者多了一个对话框的编辑只在它实际所在的
 *     位置上产生差异。合成样本上实测：加文字 / 局部马赛克 / 换色的差分 LPIPS ≤ 0.20，
 *     而不同的画 ≥ 0.52。裁切是它判不了的一类（resize 到 400×400 后每个位置都错位），
 *     留给以后的几何验证。
 *
 * 仲裁是逐对的、CPU 上几十毫秒一次，所以结果**按对缓存**在 `post_variant_edges`。
 * 那张表既是增量的来源（下一轮只算新出现的对），也是"改阈值不必重算"的原因 ——
 * 它存的是距离本身，不是判定。
 */
import type { CairnQ } from 'cairnq'
import type { getDb } from './db.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CPU_QUEUE,
  DEDUP_CHUNK_SIZE,
  DEDUP_GREY_MAX_PER_ROW,
  DEDUP_GREY_THRESHOLD,
  DEDUP_THRESHOLD,
  dedupTask,
  GPU_QUEUE,
  LPIPS_SAME_THRESHOLD,
  LPIPS_TASK_BATCH,
  lpipsVerifyTask,
} from '@pictoria/contracts'
import type { AutoEdge, VariantEdge } from '@pictoria/db'
import {
  assignFromEdges,
  edgeKey,
  exportVectorMatrix,
  listFullPaths,
  listGroupOverrides,
  listUserVerdicts,
  readEdgesByLeft,
  replaceAllGroups,
  upsertAutoEdges,
} from '@pictoria/db'
import process from 'node:process'
import { dedupMatrixPath, isDedupMatrix, pictoriaDir, thumbnailPathFor } from './paths.js'

type SqliteHandle = ReturnType<typeof getDb>['sqlite']
type Log = Pick<Console, 'info' | 'warn'>

export { DEDUP_THRESHOLD }

/**
 * 一次重建最多等多久。
 *
 * 22 万行的分块矩阵乘在一张 30xx 上是分钟级，加上 worker 可能要冷启动 torch。
 * 30 分钟给的是余量 —— 超时只代表这一轮不再等它，任务本身照常跑完。
 */
const REBUILD_TIMEOUT_MS = 30 * 60_000

/** 大到值得人眼抽查一次的组。`assignFromEdges` 的上限是 40，这里只是"看一眼"的线。 */
const BIG_GROUP = 20

/**
 * 一次重建最多仲裁多少对**新**的灰带对。
 *
 * 灰带的第一轮是一次性的存量债：全库 23 万张，即使每行只留 20 个邻居，落在
 * 0.01–0.06 之间的对也可能是几十万。CPU 上每对几十毫秒、两个并发，几十万对就是
 * 几个小时，而 `inFlight` 期间任何别的重建都要排队等它。
 *
 * 所以每轮只啃一截，按 SigLIP 距离从近到远 —— 最像的那些先有结果，用户最快看到
 * 效果。剩下的留给下一轮：证据按对缓存，重建是幂等的，多跑几轮就收敛了。
 */
const MAX_ARBITRATIONS_PER_REBUILD = 50_000

/** 与 `worker/main.py` 的 `CPU_CONCURRENCY` 对齐 —— 再多提交也只是排在队列里。 */
const ARBITRATION_CONCURRENCY = 2

/** 一批 64 对在 CPU 上是十几秒；5 分钟是给冷启动（第一次要建 onnx session）留的余量。 */
const ARBITRATION_TIMEOUT_MS = 5 * 60_000

/**
 * 边强度的三档，决定 union-find 撞上组大小上限时先放弃哪条边。
 *
 * 用户裁决 > SigLIP 直接判同 > LPIPS 仲裁判同。中间那档减去距离，同档内越近越强；
 * 用户那档用一个大常数而不是 Infinity —— `y.strength - x.strength` 排序在两个
 * Infinity 之间得到 NaN，排序会变得不确定。
 */
const USER_STRENGTH = 1e9
const SIGLIP_STRENGTH_BASE = 2

/** `2:1431 3:88 7:2` —— 每个组大小各有多少个组，大小升序。 */
function formatSizeHistogram(sizes: Map<number, number>): string {
  const hist = new Map<number, number>()
  for (const n of sizes.values()) hist.set(n, (hist.get(n) ?? 0) + 1)
  return [...hist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([size, groups]) => `${size}:${groups}`)
    .join(' ')
}

/**
 * 序列化全量重建。
 *
 * 重建以一次整体的 canonical 指针替换收尾，所以两个并发的重建就是"后写者赢"外加
 * 一次白烧的 GPU（一次被双击的 /v2/cmd/group-duplicates，或者这个端点撞上调度器
 * 写完向量后的自动重组）。形状承自已删除的 `services/dedup.py::rebuild_lock`。
 */
let inFlight: Promise<number> | null = null

/** 端点用它做"忙不忙"的判断 —— 和 Python 侧 `rebuild_lock.locked()` 同义。 */
export function isRebuilding(): boolean {
  return inFlight !== null
}

/** 灰带里的一对：已经翻译成 post id，带着召回时的 SigLIP 距离。 */
export interface GreyPair {
  a: number
  b: number
  dist: number
}

/**
 * 重建的旋钮。每一项都是 `?: T | null` 而不是 `?: T`：调用方是 HTTP 查询参数，
 * "没传"到这里就是 `null`，让它原样传进来，路由那边才不用为每个旋钮写一行
 * `...(x == null ? {} : { x })`。下面统一用 `??` 兜默认值，它对两者都生效。
 */
export interface RebuildOptions {
  /** 直接判同的余弦距离上限。 */
  threshold?: number | null
  /** 灰带上限；等于 `threshold` 就是关掉仲裁，退回原来那条单级路径。 */
  greyThreshold?: number | null
  /** 判"同一张画"的 LPIPS 距离上限。 */
  lpipsThreshold?: number | null
  /**
   * 一个组最多多少张。
   *
   * 保险丝，防的是传递闭包被一条错边串起两坨。但它是个**粗糙**的代理指标：真实的
   * 差分集（表情 x 服装 x 有码无码）轻易过 40，而两坨之间只要有几十条强边就根本
   * 不是"串"。撞上上限时被跳过的是"排序最靠后的那条边"，不是"最可疑的那条"。
   */
  maxGroupSize?: number | null
  /** 本轮最多仲裁多少对新对。 */
  maxArbitrations?: number | null
  /**
   * 取样方式。
   *
   * `nearest`（默认）先算最像的 —— 收敛用它，用户最快看到效果。
   * `spread` 在整条灰带上均匀取 —— **标定用它**：`nearest` 取出来的那批距离全挤在
   * 阈值线上（实测 2000 对全在 0.0103–0.0107），它们的判同率再高也说明不了灰带远端
   * 会不会误合并，而误合并恰恰只发生在远端。
   */
  arbitrationSampling?: 'nearest' | 'spread' | null
  /** 走完整流程但不落库 —— 用来先看一眼"这一轮会多合并多少"。 */
  dryRun?: boolean | null
  log?: Log
}

/**
 * 从头重算每个 post 的分组，返回被归组的成员数。
 *
 * 已经有一次在跑时**等它**而不是跳过：触发这一次的那些新向量同样值得一次重组，
 * 只是可以等在流程后面（Python 侧 `group_near_duplicates` 的同款选择）。
 */
export async function rebuildGroups(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  options: RebuildOptions = {},
): Promise<number> {
  while (inFlight) {
    try {
      await inFlight
    }
    catch {
      // 上一轮失败与这一轮无关 —— 它的错误已经由它自己的调用方处理了
    }
  }
  const run = doRebuild(sqlite, tasks, options)
  inFlight = run
  try {
    return await run
  }
  finally {
    inFlight = null
  }
}

/**
 * 行下标对 → post id，并按距离分成"直接判同"和"要仲裁"两档。
 *
 * 纯函数，和 `assignFromEdges` 一样：下标翻译、分档边界、方向规整这三件事的正确性
 * 不需要 GPU 就能钉住，而它们错了的表现都是"分组静悄悄地不对"。
 */
export function classifyPairs(
  ids: readonly number[],
  pairs: ReadonlyArray<readonly number[]>,
  threshold: number,
): { accepted: VariantEdge[], grey: GreyPair[] } {
  const accepted: VariantEdge[] = []
  const grey: GreyPair[] = []
  for (const pair of pairs) {
    const a = ids[pair[0] ?? -1]
    const b = ids[pair[1] ?? -1]
    // 下标越界只可能是 worker 和这一轮的矩阵对不上（跨进程边界，按输入对待）：
    // 与其拿 undefined 当 id 写进库，不如整对丢掉。
    if (a === undefined || b === undefined || a === b)
      continue
    // 距离恒定带着（见 DedupResult.pairs）；真缺了只可能是 worker 版本对不上。
    // 那时整对丢掉 —— 兜底成 0 就是"直接判同"，一次重建就是一场误合并；塞进灰带
    // 同样不行，排序和证据表都要这个数。
    const dist = pair[2]
    if (dist === undefined)
      continue
    if (dist <= threshold)
      accepted.push({ a, b, strength: SIGLIP_STRENGTH_BASE - dist })
    else
      grey.push({ a: Math.min(a, b), b: Math.max(a, b), dist })
  }
  return { accepted, grey }
}

/**
 * 把灰带里还没有结论的对送去 LPIPS，返回每一对的距离（含缓存里已有的）。
 *
 * 三种对不进仲裁队列，理由各不相同：用户裁决过的（他的话是最终的），已经算过的
 * （证据表就是为了不重算而存在），以及任一端是 standalone 的（它不会进任何组，
 * 算出来也没人用）。
 */
async function arbitrate(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  grey: readonly GreyPair[],
  opts: {
    standalone: ReadonlySet<number>
    maxArbitrations: number
    sampling: 'nearest' | 'spread'
    log: Log
  },
): Promise<{ distances: Map<string, number>, pending: number, verified: number }> {
  const distances = new Map<string, number>()
  if (grey.length === 0)
    return { distances, pending: 0, verified: 0 }

  const known = readEdgesByLeft(sqlite, [...new Set(grey.map(pair => pair.a))])
  const todo: GreyPair[] = []
  for (const pair of grey) {
    const key = edgeKey(pair.a, pair.b)
    const row = known.get(key)
    if (row?.userVerdict != null)
      continue
    if (row?.lpipsDist != null) {
      distances.set(key, row.lpipsDist)
      continue
    }
    if (opts.standalone.has(pair.a) || opts.standalone.has(pair.b))
      continue
    todo.push(pair)
  }
  if (todo.length === 0)
    return { distances, pending: 0, verified: 0 }

  // 先按距离排好，再决定取哪些，最后按 id 排序切批 —— 最后这一步让同一个 post 的
  // 几个邻居落进同一批，worker 那边按路径去重特征，一张图只解码编码一次。
  const ranked = [...todo].sort((x, y) => x.dist - y.dist)
  const picked = opts.sampling === 'spread' && ranked.length > opts.maxArbitrations
    ? Array.from(
        { length: opts.maxArbitrations },
        (_, i) => ranked[Math.floor((i * ranked.length) / opts.maxArbitrations)]!,
      )
    : ranked.slice(0, opts.maxArbitrations)
  picked.sort((x, y) => x.a - y.a || x.b - y.b)

  const needed = new Set<number>()
  for (const pair of picked) {
    needed.add(pair.a)
    needed.add(pair.b)
  }
  const fullPaths = listFullPaths(sqlite, [...needed])
  const distOf = new Map(picked.map(pair => [edgeKey(pair.a, pair.b), pair.dist]))

  const batches: GreyPair[][] = []
  for (let i = 0; i < picked.length; i += LPIPS_TASK_BATCH)
    batches.push(picked.slice(i, i + LPIPS_TASK_BATCH))

  let verified = 0
  // 仲裁走缩略图而不是原图：LPIPS 反正要 resize 到 400×400，而解码一张 4K 原图比
  // 整个前向还贵（embedding 那条流水线实测 batch 32 里 4.7 s 解码 / 0.64 s 前向）。
  const submit = async (batch: readonly GreyPair[]) => {
    const pairs = []
    for (const pair of batch) {
      const left = fullPaths.get(pair.a)
      const right = fullPaths.get(pair.b)
      // 取不到路径 = 这个 post 在导出之后被删了。跳过，下一轮它连召回都不会出现。
      if (left === undefined || right === undefined)
        continue
      pairs.push({
        a: { postId: pair.a, path: thumbnailPathFor(left) },
        b: { postId: pair.b, path: thumbnailPathFor(right) },
      })
    }
    if (pairs.length === 0)
      return
    const result = await tasks.call(lpipsVerifyTask, { pairs }, {
      queue: CPU_QUEUE,
      waitTimeoutMs: ARBITRATION_TIMEOUT_MS,
    })
    const rows: AutoEdge[] = []
    for (const one of result.results) {
      const key = edgeKey(one.a, one.b)
      distances.set(key, one.distance)
      rows.push({
        postA: one.a,
        postB: one.b,
        siglipDist: distOf.get(key) ?? null,
        lpipsDist: one.distance,
      })
    }
    // 每一批各自落库，而不是攒到最后：这一步是整个重建里最长的一段，中途崩了
    // 已经算出来的部分应当留下 —— 下一轮从证据表里读到它们，不必重算。
    upsertAutoEdges(sqlite, rows)
    verified += rows.length
    if (result.failures.length)
      opts.log.warn(`[dedup] 仲裁失败 ${result.failures.length} 对（首个：${result.failures[0]?.error ?? ''}）`)
  }

  // 每隔一段报一次进度。全量第一轮是 15 万对、近两小时，中间一行不打就等于静默 ——
  // 分不清是在算、卡住了、还是 worker 死了。
  const progressEvery = ARBITRATION_CONCURRENCY * 20
  const progressStart = Date.now()
  // 工作池而不是 `Promise.all` 分段：一批的耗时取决于它里面有多少张**唯一图**
  // （65~128 张，近 2 倍），分段跑每一轮都在等最慢的那个，全量一轮是 max 而不是
  // mean。谁先落地谁补下一批，队列始终满着。
  let next = 0
  let finished = 0
  await Promise.all(Array.from({ length: ARBITRATION_CONCURRENCY }, async () => {
    while (next < batches.length) {
      await submit(batches[next++]!)
      finished += 1
      if (finished % progressEvery === 0 && batches.length > progressEvery) {
        const elapsed = (Date.now() - progressStart) / 1000
        const done = Math.min(picked.length, finished * LPIPS_TASK_BATCH)
        const rate = done / elapsed
        const same = [...distances.values()].filter(d => d <= LPIPS_SAME_THRESHOLD).length
        opts.log.info(
          `[dedup] 仲裁进度 ${done}/${picked.length}（${(done / picked.length * 100).toFixed(1)}%，`
          + `${rate.toFixed(1)} 对/秒，剩约 ${((picked.length - done) / rate / 60).toFixed(0)} 分钟）；`
          + `累计判同 ${same}/${distances.size}`,
        )
      }
    }
  }))

  return { distances, pending: todo.length, verified }
}

/**
 * 三种边汇成一份，用户裁决优先于任何计算结果。
 *
 * `different` 是**排除**而不是"强度很低"：union-find 里没有负边，一条被判为不同的
 * 边只要还在列表里就迟早会合并两个集合。
 */
export function buildEdges(
  accepted: readonly VariantEdge[],
  grey: readonly GreyPair[],
  distances: ReadonlyMap<string, number>,
  verdicts: ReadonlyArray<{ postA: number, postB: number, verdict: 'same' | 'different' }>,
  lpipsThreshold: number,
): VariantEdge[] {
  const blocked = new Set<string>()
  const edges: VariantEdge[] = []
  for (const one of verdicts) {
    if (one.verdict === 'different')
      blocked.add(edgeKey(one.postA, one.postB))
    else
      edges.push({ a: one.postA, b: one.postB, strength: USER_STRENGTH })
  }
  for (const edge of accepted) {
    if (!blocked.has(edgeKey(edge.a, edge.b)))
      edges.push(edge)
  }
  for (const pair of grey) {
    const key = edgeKey(pair.a, pair.b)
    const lpips = distances.get(key)
    if (lpips === undefined || lpips > lpipsThreshold || blocked.has(key))
      continue
    // 归一化到 (0, 1]：整个 LPIPS 档都比 SigLIP 档弱，同档内越近越强。
    edges.push({ a: pair.a, b: pair.b, strength: 1 - lpips / lpipsThreshold })
  }
  return edges
}

async function doRebuild(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  options: RebuildOptions,
): Promise<number> {
  const threshold = options.threshold ?? DEDUP_THRESHOLD
  const greyThreshold = options.greyThreshold ?? DEDUP_GREY_THRESHOLD
  const lpipsThreshold = options.lpipsThreshold ?? LPIPS_SAME_THRESHOLD
  const maxGroupSize = options.maxGroupSize
  const maxArbitrations = options.maxArbitrations ?? MAX_ARBITRATIONS_PER_REBUILD
  const arbitrationSampling = options.arbitrationSampling ?? 'nearest'
  const dryRun = options.dryRun ?? false
  const log = options.log ?? console
  // 每次一个新文件名，不复用固定路径。超时的那一轮**不会**停掉 worker（cairnq 的
  // `pollWait` 明说了 waitTimeoutMs 只是不再等），它还 mmap 着这个文件 —— 固定路径
  // 下一轮的 `openSync(file, 'w')` 在 Windows 上会撞 EBUSY 撞到重建根本起不来。
  const started = Date.now()
  const file = dedupMatrixPath(`${process.pid}-${started}`)
  const dir = pictoriaDir()
  await fs.mkdir(dir, { recursive: true })
  // 上一次超时留下的（删不掉的那个）在这里回收。删不掉就跳过 —— 说明还有人拿着它。
  // 本轮的文件此刻还不存在（下面的 exportVectorMatrix 才创建），所以不必排除它。
  await sweepStaleMatrices(dir, log)

  try {
    // 导出也在 try 里：它中途失败（磁盘满）会留下一个半截的 1 GB 文件，
    // 而 finally 是唯一会去删它的地方。
    const { ids, count, dim } = exportVectorMatrix(sqlite, file)
    // 少于两条向量就没有"对"可言。仍然要 replaceAllGroups —— 库被清空之后
    // 残留的分组指针得跟着清掉，而不是留在那儿指向已经不存在的东西。
    if (count < 2) {
      if (!dryRun)
        replaceAllGroups(sqlite, [])
      return 0
    }

    log.info(`[dedup] 导出 ${count} 条向量（${dim} 维，${(count * dim * 4 / 1e9).toFixed(2)} GB），提交 GPU`)
    // 召回按**灰带**上限发，判同的那一档在 TS 侧用 `threshold` 切出来 —— worker
    // 一次矩阵乘就够，没必要为两个阈值跑两遍。
    // 不设 key：`conflict: 'reuse'` 会把上一次的结果原样还回来，而矩阵文件的
    // 内容每次都不同。串行化由上面的 inFlight 负责，不需要队列帮忙去重。
    const { pairs } = await tasks.call(dedupTask, {
      matrixPath: file,
      count,
      dim,
      threshold: Math.max(threshold, greyThreshold),
      chunkSize: DEDUP_CHUNK_SIZE,
      maxPerRow: DEDUP_GREY_MAX_PER_ROW,
    }, { queue: GPU_QUEUE, waitTimeoutMs: REBUILD_TIMEOUT_MS })

    // 契约说每一对都带距离；不带就是 worker 还跑着改动前的代码（Python 不热重载）。
    // 分不了档就没法仲裁，整轮停下来比悄悄按缺省值分组好。
    if (pairs.length > 0 && pairs[0]!.length < 3) {
      throw new Error(
        '[dedup] worker 回传的对不带距离 —— 几乎可以肯定是它还跑着改动前的代码：重启它再试。',
      )
    }
    const { accepted, grey } = classifyPairs(ids, pairs, threshold)
    const overrides = listGroupOverrides(sqlite)
    log.info(
      `[dedup] 召回 ${pairs.length} 对：直接判同 ${accepted.length}，灰带 ${grey.length}`
      + `（${threshold}–${greyThreshold}，每行最多 ${DEDUP_GREY_MAX_PER_ROW} 个邻居）`,
    )

    const arbitrationStarted = Date.now()
    const { distances, pending, verified } = await arbitrate(sqlite, tasks, grey, {
      standalone: overrides.standalone,
      maxArbitrations,
      sampling: arbitrationSampling,
      log,
    })
    if (pending > 0) {
      const same = [...distances.values()].filter(d => d <= lpipsThreshold).length
      log.info(
        `[dedup] 仲裁：待算 ${pending}，本轮算了 ${verified}`
        + `（${((Date.now() - arbitrationStarted) / 1000).toFixed(1)}s）；`
        + `灰带里判同 ${same}/${distances.size}（lpips ≤ ${lpipsThreshold}）`
        + (pending > verified ? `，还剩 ${pending - verified} 对留给下一轮` : ''),
      )
    }

    const verdicts = listUserVerdicts(sqlite)
    const edges = buildEdges(accepted, grey, distances, verdicts, lpipsThreshold)
    const assignments = assignFromEdges(edges, {
      excluded: overrides.standalone,
      pinned: overrides.canonical,
      ...(maxGroupSize == null ? {} : { maxGroupSize }),
    })
    if (!dryRun)
      replaceAllGroups(sqlite, assignments)

    const sizes = new Map<number, number>() // canonical -> 成员数（含 canonical 自己）
    for (const [, c] of assignments) sizes.set(c, (sizes.get(c) ?? 1) + 1)
    log.info(
      `[dedup] ${dryRun ? '（dry run，未落库）' : ''}${assignments.length} 个成员归入 ${sizes.size} 个 canonical`
      + `（threshold=${threshold}，${((Date.now() - started) / 1000).toFixed(1)}s）`
      + `\n[dedup] 组大小分布 ${formatSizeHistogram(sizes)}`,
    )
    // 传递闭包会把链连起来，代价是一条错边能串起两坨。大组是唯一的征兆，
    // 所以直接把它们的 canonical 打出来 —— 抽查一眼就知道是差分集还是串味了。
    const big = [...sizes.entries()].filter(([, n]) => n > BIG_GROUP).sort((x, y) => y[1] - x[1])
    if (big.length) {
      log.info(
        `[dedup] size>${BIG_GROUP} 的 ${big.length} 个组（canonical:size）：`
        + big.map(([c, n]) => `${c}:${n}`).join(' '),
      )
    }
    return assignments.length
  }
  finally {
    // 1 GB 的临时文件，成功失败都不留下。
    //
    // ⚠️ 删不掉不能往外抛。超时那一路 worker 还 mmap 着它，Windows 上 `fs.rm` 会
    // 得到 EBUSY（`force: true` 只吞 ENOENT），抛出去就把真正的 `TaskTimeout` 换成
    // 一个看不懂的文件错误。留给下一轮的 `sweepStaleMatrices` 收。
    await fs.rm(file, { force: true }).catch((err: unknown) =>
      log.warn(`[dedup] 临时矩阵删不掉，留给下一轮回收：${file}（${String(err)}）`))
  }
}

/**
 * 回收 `.pictoria/` 下别的 `dedup-vectors-*.f32`。
 *
 * 来源有两种：上一轮超时后 worker 还占着的那个，以及进程被杀时留下的。同一个库
 * 只有一个 API 进程、重建又由 `inFlight` 串行化，所以走到这里时**每一个**匹配的
 * 文件都是垃圾；还占着的删不掉，跳过就是了，反正下一轮还会再来一次。
 */
async function sweepStaleMatrices(dir: string, log: Log): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  }
  catch {
    return
  }
  for (const name of names) {
    // 认名字的那一半在 paths.ts，和造名字的挨着 —— 分开写迟早漂移，而漂移的表现是
    // 回收静默停摆、`.pictoria/` 下堆 1 GB 一个的文件。
    if (!isDedupMatrix(name))
      continue
    await fs.rm(path.join(dir, name), { force: true })
      .then(() => log.info(`[dedup] 回收了残留的临时矩阵 ${name}`))
      .catch(() => {})
  }
}
