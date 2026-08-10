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
import { targetDir } from './scheduler.js'

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
 * 临时矩阵文件放在库内的 `.pictoria/` 下。
 *
 * 不是随手挑的位置：worker 的 `_resolve_inside` 只接受图库根之内的路径，而
 * `.pictoria/` 本来就是这个库放自己东西的地方（`pictoria.sqlite`、`tasks.sqlite`
 * 都在那儿）。
 */
function matrixPath(): string {
  return path.resolve(targetDir(), '.pictoria/dedup-vectors.f32')
}

/**
 * 序列化全量重建。
 *
 * 重建以一次整体的 canonical 指针替换收尾，所以两个并发的重建就是"后写者赢"外加
 * 一次白烧的 GPU（一次被双击的 /v2/cmd/group-duplicates，或者这个端点撞上调度器
 * 写完向量后的自动重组）。对应 Python 侧的 `services/dedup.py::rebuild_lock`。
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
  const file = matrixPath()
  await fs.mkdir(path.dirname(file), { recursive: true })

  const started = Date.now()
  const { ids, count, dim } = exportVectorMatrix(sqlite, file)
  try {
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
    // 1 GB 的临时文件，成功失败都不留下
    await fs.rm(file, { force: true })
  }
}
