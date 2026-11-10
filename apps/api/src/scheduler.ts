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
import fs from 'node:fs'
import { queueOf } from '@pictoria/contracts'
import { onRepending, recordFailures, recordMissingFiles, scanIncomplete, type SqliteHandle } from '@pictoria/db'
import { coalesceWithCooldown, createYieldQueue } from './event-loop.js'
import { registerLoop } from './queue-status.js'
import { BACKFILL_SPECS, type WorkerSpec } from './workers.js'

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
 * 这一批一步没动。两种都让循环退到 `IDLE_MS`：把"一步没动"当成干了活就是一个不睡觉的
 * 死循环 —— 待办查询按 id 排序，下一轮选出的还是同一批。
 *
 * 文件不在盘上的项原来正是"一步没动"的来源：worker 把它们静默丢掉（`handlers.py` 的
 * `_resolve_items`），而它们排在队首，每一轮都被选中、每一轮都被丢，后面的图永远轮不到。
 * 现在提交前先查盘（`missingOnDisk`），不在的记成"文件不在盘上"黑名单（可恢复：sync 发现
 * 文件回来就清掉，见 `sync.ts`），计入 `failed` —— 它们离开了待办集合，这一批算推进了。
 */
export interface BatchOutcome {
  done: number
  failed: number
  /** 真正写进库的条数（`Persisted.written`，缺省为 `done`），`onDrained` 拿它累计。 */
  written: number
}

// 六条循环的扫描窗口共用一条让出队列：冷启动时它们同时在扫窗，各自让出的话六窗的
// 同步查询会叠在同一轮事件循环里（见 `createYieldQueue`）。
const scanTurn = createYieldQueue()

/**
 * payload 里带 `path`（原图绝对路径）的项中，文件不在盘上的那些 post id。
 *
 * 只认 ENOENT / ENOTDIR：读权限之类的错误交给 worker 去报（它会进真正的失败黑名单）。
 */
export async function missingOnDisk(items: ReadonlyArray<{ postId: number, path?: unknown }>): Promise<number[]> {
  const checks = await Promise.all(items.map(async (item) => {
    if (typeof item.path !== 'string')
      return null
    try {
      await fs.promises.access(item.path)
      return null
    }
    catch (err) {
      const code = (err as { code?: string }).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? item.postId : null
    }
  }))
  return checks.filter((id): id is number => id !== null)
}

/**
 * 通用的一批：取待办 → 组 payload → 剔掉文件不在盘上的 → 提交并等结果 → 落库 → 按规格
 * 拉黑 → 打日志。
 *
 * 六条循环原来各写一遍这一段（每段约 30 行），差别全在 `WorkerSpec` 里。
 */
export async function runBatch(
  sqlite: SqliteHandle,
  tasks: Pick<CairnQ, 'call'>,
  spec: WorkerSpec<any, any, any>,
  { log = console }: { log?: Log } = {},
): Promise<BatchOutcome | null> {
  let pending = spec.listPending(sqlite, spec.batch)
  // 扫空了一个窗口但没到表尾（进程刚启动、水位线还在 0 时就是这样，见 packages/db 的
  // `SCAN_WINDOW_ROWS`）：让出事件循环再扫下一窗，别把整表判定压成一次同步查询。
  while (!pending.length && scanIncomplete(sqlite, spec.name)) {
    await scanTurn()
    pending = spec.listPending(sqlite, spec.batch)
  }
  if (!pending.length)
    return null

  const built = spec.buildPayload(sqlite, pending)
  const missing = await missingOnDisk(built.items)
  let payload = built
  if (missing.length) {
    // 在 await 之后才落：这期间 sync 可能已经把行删了，`recordFailures` 只写还在的。
    recordMissingFiles(sqlite, spec.name, missing)
    log.warn(`[${spec.name}] ${missing.length} 条的文件不在盘上，暂时跳过（sync 发现文件回来时恢复），首个 id ${missing[0]}`)
    const gone = new Set(missing)
    payload = { ...built, items: (built.items as Array<{ postId: number }>).filter(i => !gone.has(i.postId)) }
  }
  const ids = (payload.items as Array<{ postId: number }>).map(i => i.postId)
  // 一个输入都取不到（silva：向量在两次查询之间被删了；或者整批文件都不在盘上）。
  // 待办并没有扫空。
  if (!ids.length)
    return { done: 0, failed: missing.length, written: 0 }

  const result = await tasks.call(spec.task, payload, {
    queue: queueOf(spec.task),
    // 同一批重复提交拿回同一个在跑的任务（或超时后已完成的结果），而不是第二次 GPU 计算
    key: batchKey(spec.keyPrefix ?? spec.name, ids),
    conflict: 'reuse-succeeded',
    timeoutMs: CALL_TIMEOUT_MS,
  })
  const out = spec.persist(sqlite, result, { interactive: false })
  if (spec.blacklist)
    recordFailures(sqlite, spec.name, out.failures)

  const written = out.written ?? out.done
  const failed = out.failures.length + missing.length
  log.info(
    `[${spec.name}] 落库 ${written} 条`
    + (failed ? `，拉黑 ${failed} 条` : '')
    + `${out.note ?? ''}，起始 id ${ids[0]}`,
  )
  return { done: out.done, failed, written }
}

/**
 * 一个 worker 的调度循环骨架。
 *
 * `tick` 做完一批返回 `BatchOutcome`，没活干返回 `null`。推进了就立刻接着下一批，否则
 * 退到 `IDLE_MS`。**串行**：GPU 一次只跑一个批次，多提交只是让任务在队列里排着，除了把
 * 内存花在 payload 上什么也换不到。进度记账（`queue-status.ts`）也在这里统一做，
 * tick 只管返回结果。
 *
 * 循环订阅自己那条连接上的重新待办信号（`onRepending`，见 `packages/db` 的
 * `repending.ts`），被点名时叫醒自己；`stop()` 同时退订。水位线在信号里已经由 db 包
 * 退好了（带 id 退到那张图，不带退到 0），这里只管叫醒。
 *
 * `woken` 是"读了就清"的旗：信号可能发生在一次 tick 正跑到一半的时候 —— 那时
 * `waker.resolve` 是 undefined（没在空等），旗子就是唯一还留得住这个信号的东西，让这一轮
 * 跑完不去空等。读和清之间没有 await，所以中间插不进信号。
 */
function loop(
  sqlite: SqliteHandle,
  spec: WorkerSpec<any, any, any>,
  tick: () => Promise<BatchOutcome | null>,
  log: Log,
): BackfillHandle {
  const { name } = spec
  // 计数只给状态显示用，由 `queue-status.ts` 在后台分块调用。
  const tracker = registerLoop(name, queueOf(spec.task), rows => spec.countPending(sqlite, rows))
  const controller = new AbortController()
  const { signal } = controller
  // 空等时这里放着那一次 sleep 的 resolve；信号来了就是提前调它。
  const waker: { resolve?: () => void } = {}
  let woken = false

  void (async () => {
    while (!signal.aborted) {
      woken = false
      let worked = false
      tracker.begin()
      try {
        const outcome = await tick()
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
      }
      if (!worked && !woken)
        await sleep(IDLE_MS, signal, waker)
    }
  })()

  const unsubscribe = onRepending(sqlite, (workers) => {
    if (!workers.includes(name))
      return
    woken = true
    waker.resolve?.()
  })
  return {
    name,
    stop: () => {
      controller.abort()
      unsubscribe()
    },
  }
}

/**
 * 按一份规格起一条循环。
 *
 * `spec.onDrained`：待办清空、且这一轮确实写进过东西（`Persisted.written`）时调用。只有
 * embedding 有（近重复重组）。
 *
 * 触发时机是**待办清空的那一刻**，不是每一批之后 —— 一次重建是全库分块矩阵乘，
 * 分钟级；每 16 张图触发一次等于让 GPU 什么正事都干不成。Python 侧 `run_all_backfill`
 * 跑完整轮才 fire 一次，这里的"清空即一轮结束"是它的等价物。
 *
 * 钩子是**即发即弃**的，并按 `spec.drainCooldownMs` 合并：持续上传时待办每几十秒就
 * 清空一次，原来每次都 await 一次全库重建，循环自己停着，API 也被重建的同步段拖住。
 */
export function startBackfill(
  sqlite: SqliteHandle,
  tasks: Pick<CairnQ, 'call'>,
  spec: WorkerSpec<any, any, any>,
  { log = console }: { log?: Log } = {},
): BackfillHandle {
  let writtenSinceIdle = 0
  const onDrained = spec.onDrained
  // 钩子不在循环里 await：它是分钟级的（重组），等它的话这条循环在这期间一张图都不处理。
  // 合并 + 冷却之后，跑着时或冷却期里的清空只记一笔，到点补跑一次。
  const requestDrained = onDrained && coalesceWithCooldown(
    () => onDrained({ sqlite, tasks, log }),
    spec.drainCooldownMs ?? 0,
  )
  return loop(sqlite, spec, async () => {
    const outcome = await runBatch(sqlite, tasks, spec, { log })
    if (outcome === null) {
      if (writtenSinceIdle && requestDrained) {
        log.info(`[${spec.name}] 待办清空，本轮写入 ${writtenSinceIdle} 条，请求后置钩子`)
        writtenSinceIdle = 0
        requestDrained()
      }
      return null
    }
    writtenSinceIdle += outcome.written
    return outcome
  }, log)
}

/**
 * 起全部 backfill 循环，按 `BACKFILL_SPECS` 的顺序（basics 在最前：其余 worker 的输入
 * —— 尺寸、缩略图 —— 都由它产出）。
 */
export function startBackfills(sqlite: SqliteHandle, tasks: Pick<CairnQ, 'call'>): BackfillHandle[] {
  return BACKFILL_SPECS.map(spec => startBackfill(sqlite, tasks, spec))
}
