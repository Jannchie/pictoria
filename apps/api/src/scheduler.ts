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
 * 幂等由 key + `conflict: 'reuse-succeeded'` 提供（cairnq ≥ 0.7 的状态感知
 * 语义，见 `tasks.ts` 头注）：同一批重复提交拿回同一个在跑的任务或已完成的结果，
 * 失败/取消的任务绝不复用 —— 这正好取代原来那把 `backfill_lock`，也堵死了
 * 0.6 时代"终态失败被 reuse 原样重抛、循环永久卡死"的坑。
 *
 * 每个 worker 是什么（队列、批大小、待办扫描、payload、落库、拉不拉黑）在
 * `workers.ts` 的 `WorkerSpec` 里；这里只有通用的一批（`runBatch`）和循环骨架（`loop`）。
 */
import type { CairnQ } from 'cairnq'
import { onRepending, recordFailures, type SqliteHandle } from '@pictoria/db'
import { type PendingCounter, registerLoop } from './queue-status.js'
import { BACKFILL_SPECS, embeddingSpec, type WorkerSpec } from './workers.js'

/** 队列空了之后隔多久再看一眼。 */
const IDLE_MS = 30_000
/**
 * 一批最多等多久。
 *
 * 计算本身是秒级的，但**第一批**要等 worker 把 torch 和权重载进显存，冷启动几十秒
 * 是正常的。5 分钟给的是冷启动的余量。超时不代表任务失败，只是这一轮不再等它；
 * worker 照常把它跑完。落库在 TS，超时的那一轮没落，所以下一轮的待办查询选出的
 * 还是同一批 —— 算出同一个 key，`'reuse-succeeded'` 直接捡回那个已完成任务的
 * 结果，不用重算（见 `batchKey` 和 `tasks.ts`）。
 */
const CALL_TIMEOUT_MS = 300_000

/**
 * 一批待办的任务 key：`前缀:成员id列表`。
 *
 * key 列出全部成员 id，让"同 key ⇔ 同一批成员"成立。只有首 id + 条数的话，两批
 * **不同**的成员可能撞出同一个 key（比如中间某个成员被单独处理掉之后重选的一批），
 * 而 key 相同意味着 reuse —— 上一批的结果会被错还给这一批。批大小上限 64
 * （`SILVA_TASK_BATCH`），join 出来最多几百字符，不值得为省这点长度引入摘要和
 * 它的碰撞概率。
 *
 * 有了"key 即批次内容"，`conflict: 'reuse-succeeded'` 才是安全的：同 key 的
 * succeeded 任务算的就是同一批输入，复用它是超时恢复（`CALL_TIMEOUT_MS` 的注释），
 * 不是拿陈旧数据。残余的例外只有"成员没变、图的内容变了"（转图后又清掉产物），
 * 窗口被 `tasks.ts` 对 succeeded 的 retention 1 小时封顶，且交互式重算路径
 * （`workers.ts` 的 `runOneShot`）用默认 `reuse`、不复用成功任务。
 *
 * ⚠️ 同一个"成员没变、结果不该复用"的例外还有第二种形态：**算法变了**。换 tagger 模型
 * 时这条真的发生过 —— 队列把 785 条 WD 时代的 succeeded 结果原样还了回来，而它们连
 * 字段名都对不上。所以 tagger 的 prefix（`WorkerSpec.keyPrefix`）里带上模型
 * （`tagger:pixai-tagger-v1.0`）：key 的含义因此是"这批输入 + 拿什么算的"，换模型自动
 * 换 key，旧缓存再也撞不上。别的 worker 暂时不需要，它们的模型标识没有进过 key，
 * 换模型时照这条办。
 */
export function batchKey(prefix: string, ids: number[]): string {
  return `${prefix}:${ids.join(',')}`
}

export interface BackfillHandle {
  /** 这条循环是哪个 worker。 */
  name: string
  stop: () => void
  /** 立刻结束这一轮空等，并让下一轮**强制重扫**（把待办查询的水位线清零）。 */
  wake: () => void
}

/**
 * 所有活着的循环，供 `wakeAllBackfills()` 用。
 *
 * sync 建出新行之后不该让它们干等 30 秒 —— Python 侧是同步跑完
 * `run_all_backfill`，这边等价的动作就是把空转的循环全叫醒。
 */
const handles = new Set<BackfillHandle>()

/**
 * 叫醒全部 backfill 循环，并让它们下一轮**强制重扫一次**。
 *
 * 现在只给"建出了新行"的路径用：sync 对账、Danbooru 导入、URL 导入结束时。新行的 id
 * 在水位线之上，严格说只需要叫醒、不需要 force；但这几条路径原来就是 wake + force，
 * 语义保持不变（一次重扫的代价在这些本来就分钟级的操作面前可以忽略）。
 *
 * "让 id 在水位线**以下**的老 post 重新变成待办"的写操作**不**再走这里：它们由
 * `packages/db` 的 repository 写函数自己 `notifyRepending()`（见 `repending.ts`），
 * 每条循环在 `loop()` 里订阅了自己那条连接上的信号，只有被点名的循环会被叫醒。
 * 原来那几条写路径各自在路由里记得调这个函数，漏一条就是那张图静默地永远不再被
 * backfill 碰 —— 那个知识现在长在写 SQL 的地方。
 *
 * 实现上不是"清水位线"而是给每条循环立一个 `force` 标志：水位线长在 `packages/db`
 * 里、按连接存，而循环本来就要被叫醒 —— 让同一个信号顺手把下一轮的 `{ force: true }`
 * 带进去，比再导出一个"按连接清水位线"的函数少一条能忘掉的路。
 */
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
 * 一批的结果：落库了几条、拉黑了几条。`tick` 在待办查询**扫空**时返回 `null`。
 *
 * 两者要分开：`null` 证明了此刻没有待办（状态区据此显示精确的 0），而 `{0, 0}` 只是
 * 这一批一步没动 —— worker 会把文件已经不在盘上的项静默丢掉（`handlers.py` 的
 * `_resolve_items`），整批都这样时回来的就是空结果。两种都让循环退到 `IDLE_MS`：
 * 把"一步没动"当成干了活就是一个不睡觉的死循环 —— 待办查询按 id 排序，下一轮选出的
 * 还是同一批。
 */
export interface BatchOutcome {
  done: number
  failed: number
  /** 真正写进库的条数（`Persisted.written`），`onDrained` 拿它累计。 */
  written?: number
}

/**
 * 通用的一批：取待办 → 组 payload → 提交并等结果 → 落库 → 按规格拉黑 → 打日志。
 *
 * 六条循环原来各写一遍这一段（每段约 30 行），差别全在 `WorkerSpec` 里。
 */
export async function runBatch(
  sqlite: SqliteHandle,
  tasks: Pick<CairnQ, 'call'>,
  spec: WorkerSpec<any, any, any>,
  { force, log = console }: { force: boolean, log?: Log },
): Promise<BatchOutcome | null> {
  const pending = spec.listPending(sqlite, spec.batch, { force })
  if (!pending.length)
    return null

  const payload = spec.buildPayload(sqlite, pending)
  const ids = (payload.items as Array<{ postId: number }>).map(i => i.postId)
  // 一个输入都取不到（silva：向量在两次查询之间被删了）。待办并没有扫空。
  if (!ids.length)
    return { done: 0, failed: 0 }

  const result = await tasks.call(spec.task, payload, {
    queue: spec.queue,
    // 同一批重复提交拿回同一个在跑的任务（或超时后已完成的结果），而不是第二次 GPU 计算
    key: batchKey(spec.keyPrefix, ids),
    conflict: 'reuse-succeeded',
    timeoutMs: CALL_TIMEOUT_MS,
  })
  const out = spec.persist(sqlite, result, { interactive: false })
  if (spec.blacklist)
    recordFailures(sqlite, spec.name, out.failures)

  const written = out.written ?? out.done
  log.info(
    `[${spec.name}] 落库 ${written} 条${out.writtenNote ?? ''}`
    + (out.failed ? `，拉黑 ${out.failed} 条${out.failedNote ?? ''}` : '')
    + `，起始 id ${ids[0]}`,
  )
  return { done: out.done, failed: out.failed, written }
}

/**
 * 一个 worker 的调度循环骨架。
 *
 * `tick` 做完一批返回 `BatchOutcome`，没活干返回 `null`。推进了就立刻接着下一批，否则
 * 退到 `IDLE_MS`。**串行**：GPU 一次只跑一个批次，多提交只是让任务在队列里排着，除了把
 * 内存花在 payload 上什么也换不到。进度记账（`queue-status.ts`）也在这里统一做，
 * tick 只管返回结果。
 *
 * `tick` 收到的 `force` 是 `wake()` 立的旗：这一轮的待办查询要清掉水位线重新全扫
 * （理由见 `wakeAllBackfills` 和 `packages/db` 的 `repending.ts`）。读了就清，而 wake()
 * 可能发生在一次 tick 正跑到一半的时候 —— 那时 `waker.resolve` 是 undefined（没在空等），
 * 旗子就是唯一还留得住这个信号的东西，它会被**下一轮**读走。读和清之间没有 await，
 * 所以中间插不进 wake()。
 *
 * 循环订阅自己那条连接上的重新待办信号（`onRepending`），被点名时 wake 自己；
 * `stop()` 同时退订。
 */
function loop(
  sqlite: SqliteHandle,
  name: string,
  queue: string,
  /** 此刻还剩多少待办 —— 只给状态显示用，由 `queue-status.ts` 在后台分块调用。 */
  counter: PendingCounter,
  tick: (opts: { force: boolean }) => Promise<BatchOutcome | null>,
  log: Log,
): BackfillHandle {
  const tracker = registerLoop(name, queue, counter)
  const controller = new AbortController()
  const { signal } = controller
  // 空等时这里放着那一次 sleep 的 resolve；wake() 就是提前调它。
  const waker: { resolve?: () => void } = {}
  // 显式标注：下面 `force = forceRescan` 与 `forceRescan ||= force` 互相引用，
  // 少了它 tsc 会判成循环推断（TS7022）。
  let forceRescan: boolean = false

  void (async () => {
    while (!signal.aborted) {
      const force: boolean = forceRescan
      forceRescan = false
      let worked = false
      tracker.begin()
      try {
        const outcome = await tick({ force })
        if (outcome === null) {
          tracker.idle()
        }
        else {
          tracker.record(outcome.done, outcome.failed)
          worked = outcome.done + outcome.failed > 0
        }
      }
      catch (err) {
        tracker.error(err)
        log.warn(`[${name}] 这一批失败：${String(err)}`)
        // 这一轮的强制重扫没兑现（查询可能压根没跑到）—— 旗子还回去，别把
        // 重新待办的信号吞在一次异常里。
        forceRescan ||= force
      }
      if (!worked)
        await sleep(IDLE_MS, signal, waker)
    }
  })()

  const handle: BackfillHandle = {
    name,
    stop: () => {
      controller.abort()
      handles.delete(handle)
      unsubscribe()
    },
    wake: () => {
      forceRescan = true
      waker.resolve?.()
    },
  }
  const unsubscribe = onRepending(sqlite, (workers) => {
    if ((workers as readonly string[]).includes(name))
      handle.wake()
  })
  handles.add(handle)
  return handle
}

/**
 * 按一份规格起一条循环。
 *
 * `onDrained`：待办清空、且这一轮确实写进过东西时调用，参数是这一轮写了多少条
 * （`Persisted.written`）。只有 embedding 用（近重复重组，见 `startBackfills`）。
 *
 * 触发时机是**待办清空的那一刻**，不是每一批之后 —— 一次重建是全库分块矩阵乘，
 * 分钟级；每 16 张图触发一次等于让 GPU 什么正事都干不成。Python 侧 `run_all_backfill`
 * 跑完整轮才 fire 一次，这里的"清空即一轮结束"是它的等价物。
 */
export function startBackfill(
  sqlite: SqliteHandle,
  tasks: Pick<CairnQ, 'call'>,
  spec: WorkerSpec<any, any, any>,
  { log = console, onDrained }: {
    log?: Log
    onDrained?: (written: number) => Promise<void>
  } = {},
): BackfillHandle {
  let writtenSinceIdle = 0
  return loop(sqlite, spec.name, spec.queue, rows => spec.countPending(sqlite, rows), async ({ force }) => {
    const outcome = await runBatch(sqlite, tasks, spec, { force, log })
    if (outcome === null) {
      if (writtenSinceIdle && onDrained) {
        const written = writtenSinceIdle
        // 先清零再 await：重组是分钟级的，期间新写进来的东西属于**下一轮**，
        // 不该被这一次的计数吞掉。
        writtenSinceIdle = 0
        log.info(`[${spec.name}] 待办清空，本轮写入 ${written} 条，触发近重复重组`)
        await onDrained(written)
      }
      return null
    }
    writtenSinceIdle += outcome.written ?? outcome.done
    return outcome
  }, log)
}

/**
 * 起全部 backfill 循环，按 `BACKFILL_SPECS` 的顺序（basics 在最前：其余 worker 的输入
 * —— 尺寸、缩略图 —— 都由它产出）。
 *
 * `onEmbeddingDrained`：embedding 的待办清空之后要重建近重复分组 —— 新图不经过这一步
 * 就永远不会被认成任何一张老图的重复（形状承自已删除的 EMBEDDING_WORKER.on_backfill_complete）。
 */
export function startBackfills(
  sqlite: SqliteHandle,
  tasks: Pick<CairnQ, 'call'>,
  { log = console, onEmbeddingDrained }: {
    log?: Log
    onEmbeddingDrained?: (written: number) => Promise<void>
  } = {},
): BackfillHandle[] {
  return BACKFILL_SPECS.map(spec => startBackfill(sqlite, tasks, spec, {
    log,
    onDrained: spec === embeddingSpec ? onEmbeddingDrained : undefined,
  }))
}
