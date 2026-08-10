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
import { GPU_QUEUE, SILVA_TASK_BATCH, silvaTask } from '@pictoria/contracts'
import { encodeVectorBlob } from '@pictoria/contracts'
import { fetchEmbeddingBlobs, listSilvaPending, upsertAestheticScores } from '@pictoria/db'

/** 队列空了之后隔多久再看一眼。 */
const IDLE_MS = 30_000
/**
 * 一批最多等多久。
 *
 * 一批 64 条的 head forward 是毫秒级的，但**第一批**要等 worker 把 torch 和权重
 * 载进显存，冷启动几十秒是正常的。5 分钟给的是冷启动的余量，不是计算的余量 ——
 * 超时不代表任务失败，只是这一轮不再等它；cairnq 那边照常跑完并落在结果里，
 * 下一轮的待办查询自然就看不到这些 id 了。
 */
const CALL_TIMEOUT_MS = 300_000

/** better-sqlite3 的连接类型，从 `getDb()` 借出来 —— apps/api 不直接依赖那个包。 */
type SqliteHandle = ReturnType<typeof getDb>['sqlite']

export interface BackfillHandle {
  stop: () => void
}

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
 * 把 silva / silva_luna 的待办持续喂给 worker。
 *
 * 一批一批**串行**：GPU 一次只跑一个批次，多提交只是让任务在队列里排着，除了
 * 把内存花在 payload 上什么也换不到。空了就退到 `IDLE_MS` 再看。
 */
export function startSilvaBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { scorer, log = console }: { scorer: 'silva' | 'silva_luna', log?: Pick<Console, 'info' | 'warn'> },
): BackfillHandle {
  const controller = new AbortController()
  const { signal } = controller

  void (async () => {
    while (!signal.aborted) {
      const pending = listSilvaPending(sqlite, scorer, SILVA_TASK_BATCH)
      if (!pending.length) {
        await sleep(IDLE_MS, signal)
        continue
      }

      const blobs = fetchEmbeddingBlobs(sqlite, pending)
      const items = pending
        .filter(pid => blobs.has(pid))
        .map(pid => ({ postId: pid, embedding: encodeVectorBlob(blobs.get(pid)!) }))
      if (!items.length) {
        // 待办查询说它们有向量，取的时候却没有 —— 两次查询之间被删了。退避一轮，
        // 下次待办查询就不会再看到它们。
        await sleep(IDLE_MS, signal)
        continue
      }

      try {
        const result = await tasks.call(silvaTask, { scorer, items }, {
          queue: GPU_QUEUE,
          // 同一批重复提交拿回同一个任务，而不是第二次 GPU 计算
          key: `${scorer}:${items[0]!.postId}:${items.length}`,
          conflict: 'reuse',
          waitTimeoutMs: CALL_TIMEOUT_MS,
        })
        upsertAestheticScores(sqlite, scorer, result.scores)
        log.info(`[${scorer}] 落库 ${result.scores.length} 条，起始 id ${items[0]!.postId}`)
      }
      catch (err) {
        // 一次失败不拉黑：能取到向量就应该能打分，所以失败是暂时的/代码的问题，
        // 值得下一轮重试，而不是把这批数据永久跳过（与 Python 侧的
        // blacklist_policy = never 同义）。
        log.warn(`[${scorer}] 这一批失败（${items.length} 条，起始 id ${items[0]!.postId}）：${String(err)}`)
        await sleep(IDLE_MS, signal)
      }
    }
  })()

  return { stop: () => controller.abort() }
}
