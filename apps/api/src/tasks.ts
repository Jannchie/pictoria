/**
 * cairnq 客户端句柄。
 *
 * **`tasks.sqlite` 是独立文件，不和图库共用**（§4.3）。SQLite 一次只允许一个写者，
 * 而 cairnq 的租约续约和心跳是高频小写 —— 正好是那种会挡在图库正常写前面、让它
 * 排队的流量。分文件之后两者各写各的。
 */
import type { CallOptions, TaskDef } from 'cairnq'
import { CairnQ, isSucceeded, isTerminal } from 'cairnq'
import { tasksDbPath } from './paths.js'

let handle: CairnQ | null = null
let purge: { stop: () => void } | null = null

export async function getTasks(): Promise<CairnQ> {
  if (!handle) {
    handle = CairnQ.sqlite(tasksDbPath())
    await handle.connect()
    // 谁打开队列谁维护它。挂在 index.ts 的调度开关下不行：PICTORIA_SCHEDULER=0
    // 的进程照样通过交互端点（即时打分、文本搜索）往 tasks.sqlite 塞大 payload，
    // 却永远不清。
    purge = startTaskPurge(handle)
  }
  return handle
}

export async function closeTasks(): Promise<void> {
  purge?.stop()
  purge = null
  await handle?.close()
  handle = null
}

/**
 * 带 key 的 `call`，但**只复用还在跑的那个任务**。
 *
 * 直接写 `key` + `conflict: 'reuse'` 是个陷阱：cairnq 的 reuse 分支不看状态
 * （`store/base.js` 的 `if (conflict === "reuse") return rowToTask(current)`），
 * 于是同一个 key 命中一个**终态**任务时：
 *
 * * 失败的 → `call()` 原样重抛它的 `TaskFailed`。没人调 `purge()`，key 行留在
 *   `tasks.sqlite` 里，重启也不清 —— 那个 key 从此永久 500；
 * * 成功的 → 拿回上一次的结果。图转过一次之后再点"自动标签"，回来的还是转之前
 *   的标签。
 *
 * 所以先按 key 读一眼：终态就 `replace`（把 key 重指到新任务上），在跑就
 * `reuse`（这才是 key 的本意 —— 用户连点两下、防抖打出同一串 prompt）。
 *
 * ⚠️ 检查和提交是两步，中间隔着 await —— 裸写的话两个并发的同 key 调用会**双双**
 * 看到同一个终态任务、双双选 `replace`，而 cairnq 的 replace 会把对方刚建出来的
 * 新任务 cancel 掉（`store/base.js` 的 `fetch("cancel", ...)`）：一边 500
 * （`TaskCanceled`）加一次白烧的 GPU，恰好发生在 key 本该防住的那种双击上。
 * 所以同一个 key 的在途调用在**进程内合流**（`inFlightByKey`）：第二个调用加入
 * 第一个、拿同一份结果，检查和提交之间再也不会插进同 key 的第二次检查。写 key 的
 * 只有这一个进程，所以进程内合流就是全部 —— worker 从不提交任务。
 *
 * `reuseSucceeded` 给两种任务开的口子：**输入全在 key 里**的（文本 embedding 的
 * key 就是 prompt 本身，结果确定，复用是真缓存），以及 **key 恒等于"这一批的
 * 内容"**的 backfill 批次（key 带成员 id，见 `scheduler.ts` 的 `batchKey`）——
 * 对后者它是超时恢复：一批算完了但 `call` 已经超时返回，结果没落库，下一轮选出
 * 同一批、算出同一个 key，复用那个 succeeded 任务就是免费捡回结果，而不是 cancel
 * 掉它整批重算。默认关着 —— 其余的 key 里只有 post id，而 post 的内容会变。
 *
 * 不需要幂等的路径就**别传 key**（`routes/images.ts` 的缩略图、`dedup.ts` 的矩阵
 * 都是这么做的，各自的注释有原因）。
 */
const inFlightByKey = new Map<string, Promise<unknown>>()

export async function callKeyed<P, R>(
  tasks: CairnQ,
  task: TaskDef<P, R>,
  payload: P,
  opts: CallOptions & { key: string, reuseSucceeded?: boolean },
): Promise<R> {
  const joined = inFlightByKey.get(opts.key)
  if (joined)
    return joined as Promise<R>

  const run = (async () => {
    const { reuseSucceeded = false, ...call } = opts
    const existing = await tasks.getByKey(opts.key)
    const stale = existing !== null && isTerminal(existing) && !(reuseSucceeded && isSucceeded(existing))
    return tasks.call(task, payload, { ...call, conflict: stale ? 'replace' : 'reuse' })
  })()
  inFlightByKey.set(opts.key, run)
  try {
    return await run
  }
  finally {
    inFlightByKey.delete(opts.key)
  }
}

/**
 * 定期清掉 `tasks.sqlite` 里的终态任务。
 *
 * cairnq 自己不删任何行（`purge()` 的文档原话：长生命周期的库需要按计划调它），
 * 而这个队列扛的全是大 payload —— silva 每个任务约 384 KB × 2 个 scorer，每一批
 * embedding 的结果，每一个不同的搜索 prompt。跑完一次 22 万图的 backfill 就会留下
 * 几个 GB 的终态行，永远不回收。
 *
 * 保留 24 小时：足够事后翻一次失败任务的错误信息，又不至于让库长成那样。
 * `purge` 每次按 `limit` 截断以免写事务太长，所以要循环到它返回的少于一批为止。
 */
const PURGE_INTERVAL_MS = 3_600_000
const PURGE_OLDER_THAN_MS = 24 * 3_600_000
const PURGE_BATCH = 500
/**
 * 第一次清扫要等的时间。
 *
 * 不能在启动时就扫：cairnq 的 SQLite store 是 better-sqlite3（同步），而它的锁只经
 * 微任务解析，两批之间没有宏任务让出点 —— 一次积压清扫是几十个连续写事务，全都压在
 * 一个**已经在监听端口**的进程上，和启动时的全库 sync 扫描、六条 backfill 循环的
 * 首次待办查询挤在同一个 IIFE 里。攒了一整轮 backfill 的话那是约 4 万条终态行。
 * 推迟一分钟，让启动路径先跑完。
 */
const PURGE_FIRST_DELAY_MS = 60_000

function startTaskPurge(
  tasks: CairnQ,
  { log = console }: { log?: Pick<Console, 'info' | 'warn'> } = {},
): { stop: () => void } {
  const sweep = async () => {
    let total = 0
    for (;;) {
      const ids = await tasks.purge({ olderThanMs: PURGE_OLDER_THAN_MS, limit: PURGE_BATCH })
      total += ids.length
      if (ids.length < PURGE_BATCH)
        break
      // 批之间让出一个宏任务：`purge` 的每一批都是一次同步写事务，连着跑就是把
      // 事件循环整段占住。请求比清扫急。
      await new Promise(resolve => setImmediate(resolve))
    }
    if (total)
      log.info(`[tasks] 清掉 ${total} 条 24 小时前的终态任务`)
  }
  const tick = () => {
    void sweep().catch((err: unknown) => log.warn(`[tasks] purge 失败：${String(err)}`))
  }

  let timer: NodeJS.Timeout = setTimeout(() => {
    tick()
    timer = setInterval(tick, PURGE_INTERVAL_MS)
    timer.unref()
  }, PURGE_FIRST_DELAY_MS)
  // 别让这两个定时器把进程钉在事件循环里（和 sync 的轮询同一个理由）
  timer.unref()
  return { stop: () => clearTimeout(timer) }
}
