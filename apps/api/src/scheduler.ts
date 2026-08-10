/**
 * Backfill 调度 —— 谁决定"接下来算什么"（`docs/refactor-monorepo-hono.md` §D2）。
 *
 * 原来这件事在 Python API 进程里：六个 worker 各开一条连接轮询自己的 pending，
 * 外加一个 watchdog 和一把 `backfill_lock`。搬过来之后职责一分为二：
 *
 * * **挑活**在 TS —— 待办查询读的是 `pictoria.sqlite`，而这个库只有一个写者，
 *   就是这个进程；
 * * **干活**在 Python worker —— 通过 cairnq，一次一批，GPU 的排队交给队列。
 *
 * 幂等由 cairnq 的 `key` + `conflict: 'reuse'` 提供：同一批重复提交拿回的是同一个
 * 任务而不是第二次计算，这正好取代原来那把 `backfill_lock`。
 */
import type { CairnQ } from 'cairnq'
import type { getDb } from './db.js'
import path from 'node:path'
import process from 'node:process'
import {
  encodeVectorBlob,
  GPU_QUEUE,
  SILVA_TASK_BATCH,
  silvaTask,
  WAIFU_TASK_BATCH,
  WAIFU_WORKER_KEY,
  waifuTask,
} from '@pictoria/contracts'
import {
  fetchEmbeddingBlobs,
  listSilvaPending,
  listWaifuPending,
  recordFailures,
  upsertAestheticScores,
  upsertWaifuScores,
} from '@pictoria/db'
import { repoRoot } from './db.js'

/** better-sqlite3 的连接类型，从 `getDb()` 借出来 —— apps/api 不直接依赖那个包。 */
type SqliteHandle = ReturnType<typeof getDb>['sqlite']

/** 队列空了之后隔多久再看一眼。 */
const IDLE_MS = 30_000
/**
 * 一批最多等多久。
 *
 * 计算本身是秒级的，但**第一批**要等 worker 把 torch 和权重载进显存，冷启动几十秒
 * 是正常的。5 分钟给的是冷启动的余量。超时不代表任务失败，只是这一轮不再等它；
 * cairnq 那边照常跑完并落在结果里，下一轮的待办查询自然就看不到这些 id 了。
 */
const CALL_TIMEOUT_MS = 300_000

export interface BackfillHandle {
  stop: () => void
}

type Log = Pick<Console, 'info' | 'warn'>

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

/**
 * 一个 worker 的调度循环骨架。
 *
 * `tick` 做完一批返回 `true`，没活干返回 `false`。有活就立刻接着下一批，没活就退到
 * `IDLE_MS`。**串行**：GPU 一次只跑一个批次，多提交只是让任务在队列里排着，除了把
 * 内存花在 payload 上什么也换不到。
 */
function loop(name: string, tick: () => Promise<boolean>, log: Log): BackfillHandle {
  const controller = new AbortController()
  const { signal } = controller

  void (async () => {
    while (!signal.aborted) {
      let worked = false
      try {
        worked = await tick()
      }
      catch (err) {
        log.warn(`[${name}] 这一批失败：${String(err)}`)
      }
      if (!worked)
        await sleep(IDLE_MS, signal)
    }
  })()

  return { stop: () => controller.abort() }
}

/** 与 `db.ts` 同规则解析出的图库绝对根目录 —— worker 用它校验路径没有逃逸。 */
export function targetDir(): string {
  return path.resolve(repoRoot(), process.env.PICTORIA_TARGET_DIR ?? 'server/illustration/images')
}

/**
 * SILVA / SILVA-Luna：输入是已存的向量，输出一个标量。
 *
 * 失败不拉黑 —— 能取到向量就应该能打分，所以失败是暂时的/代码的问题，值得下一轮
 * 重试，而不是把这批数据永久跳过（与 Python 侧的 `blacklist_policy = never` 同义）。
 */
export function startSilvaBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { scorer, log = console }: { scorer: 'silva' | 'silva_luna', log?: Log },
): BackfillHandle {
  return loop(scorer, async () => {
    const pending = listSilvaPending(sqlite, scorer, SILVA_TASK_BATCH)
    if (!pending.length)
      return false

    const blobs = fetchEmbeddingBlobs(sqlite, pending)
    const items = pending
      .filter(pid => blobs.has(pid))
      .map(pid => ({ postId: pid, embedding: encodeVectorBlob(blobs.get(pid)!) }))
    // 待办查询说它们有向量，取的时候却没有 —— 两次查询之间被删了。
    if (!items.length)
      return false

    const result = await tasks.call(silvaTask, { scorer, items }, {
      queue: GPU_QUEUE,
      // 同一批重复提交拿回同一个任务，而不是第二次 GPU 计算
      key: `${scorer}:${items[0]!.postId}:${items.length}`,
      conflict: 'reuse',
      waitTimeoutMs: CALL_TIMEOUT_MS,
    })
    upsertAestheticScores(sqlite, scorer, result.scores)
    log.info(`[${scorer}] 落库 ${result.scores.length} 条，起始 id ${items[0]!.postId}`)
    return true
  }, log)
}

/**
 * waifu：输入是图片本身。
 *
 * 与 silva 的关键差别是失败**要**拉黑：一张读不出来的图不会自己变好，不拉黑的话
 * 待办查询每一轮都会重选它，永远卡在同一批上（Python 侧的
 * `blacklist_policy = "ladder"`）。
 */
export function startWaifuBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { log = console }: { log?: Log } = {},
): BackfillHandle {
  const root = targetDir()
  return loop('waifu', async () => {
    const items = listWaifuPending(sqlite, root, WAIFU_TASK_BATCH)
    if (!items.length)
      return false

    const result = await tasks.call(waifuTask, { items }, {
      queue: GPU_QUEUE,
      key: `waifu:${items[0]!.postId}:${items.length}`,
      conflict: 'reuse',
      waitTimeoutMs: CALL_TIMEOUT_MS,
    })
    upsertWaifuScores(sqlite, result.scores)
    recordFailures(sqlite, WAIFU_WORKER_KEY, result.failures)
    log.info(
      `[waifu] 落库 ${result.scores.length} 条`
      + (result.failures.length ? `，拉黑 ${result.failures.length} 条` : '')
      + `，起始 id ${items[0]!.postId}`,
    )
    // 整批都失败时仍然算"干了活"：黑名单已经写下，下一轮的待办查询不会再选它们，
    // 所以立刻继续而不是空等 30 秒。
    return true
  }, log)
}
