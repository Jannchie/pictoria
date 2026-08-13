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
import {
  BASICS_TASK_BATCH,
  BASICS_WORKER_KEY,
  basicsTask,
  EMBEDDING_TASK_BATCH,
  EMBEDDING_WORKER_KEY,
  embeddingTask,
  encodeVectorBlob,
  GPU_QUEUE,
  IO_QUEUE,
  SILVA_TASK_BATCH,
  silvaTask,
  TAGGER_TASK_BATCH,
  TAGGER_WORKER_KEY,
  taggerTask,
  WAIFU_TASK_BATCH,
  WAIFU_WORKER_KEY,
  waifuTask,
} from '@pictoria/contracts'
import { Buffer } from 'node:buffer'
import {
  ensureCanonicalTagGroups,
  listBasicsPending,
  fetchEmbeddingBlobs,
  listEmbeddingPending,
  listSilvaPending,
  listTaggerPending,
  listWaifuPending,
  persistTaggerResults,
  recordFailures,
  upsertAestheticScores,
  upsertBasics,
  upsertVectors,
  upsertWaifuScores,
} from '@pictoria/db'
import { targetDir } from './paths.js'

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
  /** 立刻结束这一轮空等，去看一眼有没有新活。 */
  wake: () => void
}

/**
 * 所有活着的循环，供 `wakeAllBackfills()` 用。
 *
 * sync 建出新行之后不该让它们干等 30 秒 —— Python 侧是同步跑完
 * `run_all_backfill`，这边等价的动作就是把空转的循环全叫醒。
 */
const handles = new Set<BackfillHandle>()

export function wakeAllBackfills(): void {
  for (const h of handles) h.wake()
}

type Log = Pick<Console, 'info' | 'warn'>

/**
 * 可被 abort 或 `waker` 提前打断的 sleep。
 *
 * `{ once: true }` 只在事件**真的触发**时摘掉监听器，而正常路径是 setTimeout 自己
 * 到期 —— 那条路径不摘的话，每个空闲周期都往同一个 signal 上堆一个监听器（6 个循环
 * × 每分钟 2 轮 ≈ 每天 1.7 万个），每个都闭包持有已经过期的 Timeout。所以三条出口
 * 都走同一个 `finish`，由它负责摘。
 */
function sleep(ms: number, signal: AbortSignal, waker: { resolve?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', finish)
      waker.resolve = undefined
      resolve()
    }
    const t = setTimeout(finish, ms)
    waker.resolve = finish
    signal.addEventListener('abort', finish, { once: true })
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
  // 空等时这里放着那一次 sleep 的 resolve；wake() 就是提前调它。
  const waker: { resolve?: () => void } = {}

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
        await sleep(IDLE_MS, signal, waker)
    }
  })()

  const handle: BackfillHandle = {
    stop: () => {
      controller.abort()
      handles.delete(handle)
    },
    wake: () => waker.resolve?.(),
  }
  handles.add(handle)
  return handle
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

/**
 * tagger：算在 Python，落库在 TS —— 三个 worker 里落库最复杂的一个。
 *
 * worker 只回传标签名和 rating 字符串。哪个标签属于哪个组、rating 能不能覆盖已有值，
 * 都是 schema 的知识，留在拥有 schema 的这一侧。
 */
export function startTaggerBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { log = console }: { log?: Log } = {},
): BackfillHandle {
  const root = targetDir()
  return loop('tagger', async () => {
    const items = listTaggerPending(sqlite, root, TAGGER_TASK_BATCH)
    if (!items.length)
      return false

    const result = await tasks.call(taggerTask, { items }, {
      queue: GPU_QUEUE,
      key: `tagger:${items[0]!.postId}:${items.length}`,
      conflict: 'reuse',
      waitTimeoutMs: CALL_TIMEOUT_MS,
    })

    const groups = ensureCanonicalTagGroups(sqlite)
    // 落库后仍然没有 is_auto 行的那些 —— tagger 产出的标签全部被同名手工标签遮住了。
    // 重跑只会得到同样的结果，所以和读不出来的图一样拉黑。
    const shadowed = persistTaggerResults(sqlite, result.results, groups)
    recordFailures(sqlite, TAGGER_WORKER_KEY, [
      ...result.failures,
      ...shadowed.map(postId => ({ postId, error: 'all auto tags shadowed by manual tags' })),
    ])
    log.info(
      `[tagger] 落库 ${result.results.length} 条`
      + (result.failures.length || shadowed.length
        ? `，拉黑 ${result.failures.length + shadowed.length} 条（${shadowed.length} 条被手工标签遮住）`
        : '')
      + `，起始 id ${items[0]!.postId}`,
    )
    return true
  }, log)
}

/**
 * embedding：SigLIP 2 检索向量。
 *
 * 唯一带**后置钩子**的 worker，对应 Python 侧 `EMBEDDING_WORKER.on_backfill_complete`：
 * 写进新向量之后要重建近重复分组，否则新图永远不会被认成任何一张老图的重复。
 *
 * 触发时机是**待办清空的那一刻**，不是每一批之后 —— 一次重建是全库分块矩阵乘，
 * 分钟级；每 16 张图触发一次等于让 GPU 什么正事都干不成。Python 侧 `run_all_backfill`
 * 跑完整轮才 fire 一次，这里的"清空即一轮结束"是它的等价物。
 */
export function startEmbeddingBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { log = console, onDrained }: {
    log?: Log
    /** 待办清空、且这一轮确实写进过向量时调用，参数是这一轮写了多少条。 */
    onDrained?: (written: number) => Promise<void>
  } = {},
): BackfillHandle {
  const root = targetDir()
  let writtenSinceIdle = 0
  return loop('embedding', async () => {
    const items = listEmbeddingPending(sqlite, root, EMBEDDING_TASK_BATCH)
    if (!items.length) {
      if (writtenSinceIdle && onDrained) {
        const written = writtenSinceIdle
        // 先清零再 await：重组是分钟级的，期间新写进来的向量属于**下一轮**，
        // 不该被这一次的计数吞掉。
        writtenSinceIdle = 0
        log.info(`[embedding] 待办清空，本轮写入 ${written} 条，触发近重复重组`)
        await onDrained(written)
      }
      return false
    }

    const result = await tasks.call(embeddingTask, { items }, {
      queue: GPU_QUEUE,
      key: `embedding:${items[0]!.postId}:${items.length}`,
      conflict: 'reuse',
      waitTimeoutMs: CALL_TIMEOUT_MS,
    })
    upsertVectors(sqlite, result.embeddings.map(e => ({
      postId: e.postId,
      embedding: Buffer.from(e.embedding, 'base64'),
    })))
    recordFailures(sqlite, EMBEDDING_WORKER_KEY, result.failures)
    writtenSinceIdle += result.embeddings.length
    log.info(
      `[embedding] 落库 ${result.embeddings.length} 条`
      + (result.failures.length ? `，拉黑 ${result.failures.length} 条` : '')
      + `，起始 id ${items[0]!.postId}`,
    )
    return true
  }, log)
}

/**
 * basics：sha256 / arthash / 尺寸 / 调色板 / 主色，外加缩略图。
 *
 * 六个 worker 里唯一不碰模型的一个，所以它走 IO 队列（并发 4）而不是 GPU 队列。
 * 失败**要**拉黑，而且有两种：读不出来的文件，以及解码成功但取不出调色板的
 * （退化的纯色图）。后者其余字段照常落库，只有 `dominant_color` 留 NULL ——
 * 而那正是待办查询的条件之一，不拉黑就会每一轮重选它。
 */
export function startBasicsBackfill(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  { log = console }: { log?: Log } = {},
): BackfillHandle {
  const root = targetDir()
  return loop('basics', async () => {
    const items = listBasicsPending(sqlite, root, BASICS_TASK_BATCH)
    if (!items.length)
      return false

    const result = await tasks.call(basicsTask, { items }, {
      queue: IO_QUEUE,
      key: `basics:${items[0]!.postId}:${items.length}`,
      conflict: 'reuse',
      waitTimeoutMs: CALL_TIMEOUT_MS,
    })
    upsertBasics(sqlite, result.rows)
    recordFailures(sqlite, BASICS_WORKER_KEY, result.failures)
    log.info(
      `[basics] 落库 ${result.rows.length} 条`
      + (result.failures.length ? `，拉黑 ${result.failures.length} 条` : '')
      + `，起始 id ${items[0]!.postId}`,
    )
    return true
  }, log)
}
