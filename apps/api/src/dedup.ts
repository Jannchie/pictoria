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
 */
import type { CairnQ } from 'cairnq'
import type { getDb } from './db.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEDUP_CHUNK_SIZE,
  DEDUP_THRESHOLD,
  dedupTask,
  GPU_QUEUE,
} from '@pictoria/contracts'
import {
  assignFromPairs,
  exportVectorMatrix,
  replaceAllGroups,
} from '@pictoria/db'
import process from 'node:process'
import { dedupMatrixPath, isDedupMatrix, pictoriaDir } from './paths.js'

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

/**
 * 从头重算每个 post 的分组，返回被归组的成员数。
 *
 * 已经有一次在跑时**等它**而不是跳过：触发这一次的那些新向量同样值得一次重组，
 * 只是可以等在流程后面（Python 侧 `group_near_duplicates` 的同款选择）。
 */
export async function rebuildGroups(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { threshold = DEDUP_THRESHOLD, log = console }: { threshold?: number, log?: Log } = {},
): Promise<number> {
  while (inFlight) {
    try {
      await inFlight
    }
    catch {
      // 上一轮失败与这一轮无关 —— 它的错误已经由它自己的调用方处理了
    }
  }
  const run = doRebuild(sqlite, tasks, threshold, log)
  inFlight = run
  try {
    return await run
  }
  finally {
    inFlight = null
  }
}

async function doRebuild(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  threshold: number,
  log: Log,
): Promise<number> {
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
      replaceAllGroups(sqlite, [])
      return 0
    }

    log.info(`[dedup] 导出 ${count} 条向量（${dim} 维，${(count * dim * 4 / 1e9).toFixed(2)} GB），提交 GPU`)
    // 不设 key：`conflict: 'reuse'` 会把上一次的结果原样还回来，而矩阵文件的
    // 内容每次都不同。串行化由上面的 inFlight 负责，不需要队列帮忙去重。
    const { pairs } = await tasks.call(dedupTask, {
      matrixPath: file,
      count,
      dim,
      threshold,
      chunkSize: DEDUP_CHUNK_SIZE,
    }, { queue: GPU_QUEUE, waitTimeoutMs: REBUILD_TIMEOUT_MS })

    const assignments = assignFromPairs(ids, pairs)
    replaceAllGroups(sqlite, assignments)

    const canonicals = new Set(assignments.map(([, c]) => c))
    log.info(
      `[dedup] ${assignments.length} 个成员归入 ${canonicals.size} 个 canonical`
      + `（threshold=${threshold}，${((Date.now() - started) / 1000).toFixed(1)}s）`,
    )
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
