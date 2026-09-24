/**
 * 后台队列的运行状况 —— 给前端侧栏的"同步状态"区用，调度本身不读它。
 *
 * 每条 backfill 循环（`scheduler.ts` 的 `loop`）登记一个 `LoopTracker`，在每批开始、
 * 落库、扫空、出错时报一声。这里只做记账，不碰调度决策。
 *
 * ## 剩余量怎么来的
 *
 * 循环自己只知道"下一批是谁"，不知道总共还剩多少，而完整地数一遍待办很贵：
 * better-sqlite3 是同步的，整库重打标时 tagger 一次数完实测 1.6 秒，那 1.6 秒里 API
 * 的每个请求都在排队。所以剩余量是三层来源拼起来的：
 *
 * 1. **扫空 = 精确的 0。** 待办查询一条都没选出来，就是它本身证明了此刻没有待办，不用数。
 * 2. **忙时在后台分块数。** 快照从不等计数：它返回当前估计，到点了就在后台排一次计数。
 *    计数由 `packages/db` 从水位线起按 `COUNT_CHUNK_ROWS` 行一块给出，块与块之间让出
 *    事件循环；所有循环的计数排在同一条串行链上（`countChain`），于是任一时刻最多只有
 *    一块在跑 —— 几条循环同时到点也不会把各自的一块叠进同一轮事件循环。数完一遍花了
 *    d 毫秒的同步时间，下一遍至少隔 `max(MIN_COUNT_INTERVAL_MS, d × COUNT_COST_FACTOR)`。
 * 3. **两次计数之间递减。** 用上次的精确值减去此后落库的条数。新导入的图会让它偏小，
 *    下一次计数纠正。
 *
 * ## 速度与剩余时间
 *
 * 速度用这一段忙碌期里、最近 `RATE_WINDOW_MS` 内完成的批次算：条数之和 ÷（最后一批
 * 结束 − 最早一批开始）。是墙钟吞吐 —— GPU 队列上几条循环轮流用卡，各自的速度里已经
 * 含了等卡的时间，所以"剩余 ÷ 速度"就是这条循环按当前节奏跑完要多久。
 */

/** 前端可见的循环状态。`idle` = 最近一轮扫空；`working` = 正在消化积压；`error` = 最近一批抛了。 */
export type LoopState = 'idle' | 'working' | 'error'

const RATE_WINDOW_MS = 10 * 60_000
const MIN_COUNT_INTERVAL_MS = 20_000
const COUNT_COST_FACTOR = 50
/**
 * 一个计数块的行数。tagger 最贵：整库重打标时 5000 行一块，计数期间 API 请求的最长
 * 延迟实测 152 ms，减半到 2500 行。
 */
const COUNT_CHUNK_ROWS = 2500

/** 一条循环的待办计数：按 `chunkRows` 行一块、逐块给出条数（`packages/db` 的 `count*Pending`）。 */
export type PendingCounter = (chunkRows: number) => Iterable<number>

interface Batch {
  start: number
  end: number
  done: number
}

export interface LoopStatus {
  key: string
  queue: string
  state: LoopState
  /** 还剩多少条；`null` = 还没数出来（刚开始忙、第一遍计数还在跑）。 */
  remaining: number | null
  /** 进程启动以来落库的条数。 */
  processed: number
  /** 进程启动以来被拉黑的条数。 */
  failed: number
  /** 这一段忙碌期（上次扫空之后）已经完成的条数 —— 进度条的分子。 */
  sessionDone: number
  /** 每秒条数；这一段忙碌期里还没完成过批次时为 `null`。 */
  ratePerSecond: number | null
  /** 预计还要多少秒；速度或剩余未知时为 `null`。 */
  etaSeconds: number | null
  /** 当前这一批开始的时间（epoch ms）；不在跑时为 `null`。 */
  batchStartedAt: number | null
  lastBatchAt: number | null
  lastError: string | null
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

/** 全部循环共用的计数串行链，理由见文件头注第 2 条。 */
let countChain: Promise<void> = Promise.resolve()

export class LoopTracker {
  private state: LoopState = 'idle'
  private processed = 0
  private failed = 0
  private sessionDone = 0
  private batches: Batch[] = []
  private batchStartedAt: number | null = null
  private lastBatchAt: number | null = null
  private lastError: string | null = null
  // 上一次精确计数的结果，以及那次计数开始时的 `sessionDone` —— 剩余 = counted − 此后完成的
  private counted: number | null = null
  private countBase = 0
  private nextCountAt = 0
  private counting: Promise<void> | null = null
  // 每次扫空 +1。计数途中转入扫空的话，数出来的就是过期的积压，不能写回去。
  private epoch = 0

  constructor(
    readonly key: string,
    readonly queue: string,
    private readonly counter: PendingCounter,
    private readonly now: () => number = Date.now,
  ) {}

  /** 一批开始（待办查询之前）。 */
  begin(): void {
    this.batchStartedAt = this.now()
  }

  /** 一批落库完成：`done` 条写进去了，`failed` 条被拉黑（都可能是 0 —— 一批没推进）。 */
  record(done: number, failed: number): void {
    const end = this.now()
    const total = done + failed
    // 扫空之后的第一批：积压是新冒出来的，"精确的 0"已经过期，下一次快照立刻重数。
    if (this.state === 'idle')
      this.counted = null
    this.processed += done
    this.failed += failed
    this.sessionDone += total
    this.batches.push({ start: this.batchStartedAt ?? end, end, done: total })
    this.lastBatchAt = end
    this.lastError = null
    this.state = 'working'
  }

  /** 待办查询扫空：此刻没有待办。 */
  idle(): void {
    this.batchStartedAt = null
    this.state = 'idle'
    this.sessionDone = 0
    // 速度只描述这一段忙碌期：留着上一段的批次，下一段的速度就会把中间的空闲算进去。
    this.batches = []
    this.counted = 0
    this.countBase = 0
    this.epoch += 1
  }

  error(err: unknown): void {
    this.batchStartedAt = null
    this.state = 'error'
    this.lastError = String(err)
  }

  /** 进行中（或排队中）的那次后台计数；没有就立即 resolve。测试用来等计数落定。 */
  settled(): Promise<void> {
    return this.counting ?? Promise.resolve()
  }

  private async recount(): Promise<void> {
    const epoch = this.epoch
    const base = this.sessionDone
    let total = 0
    let busyMs = 0
    try {
      const chunks = this.counter(COUNT_CHUNK_ROWS)[Symbol.iterator]()
      for (;;) {
        // 每块之前都让一次，包括第一块：触发计数的是一个 HTTP 请求，别在它里面数。
        await yieldToEventLoop()
        const t = performance.now()
        const chunk = chunks.next()
        busyMs += performance.now() - t
        if (chunk.done)
          break
        total += chunk.value
      }
      if (epoch !== this.epoch)
        return
      this.counted = total
      // 计数期间落库的那些，一部分在已数过的块里（已经不在 total 里），一部分还没数到；
      // 一律当成"之后落库的"继续递减，误差不超过计数期间完成的条数。
      this.countBase = base
    }
    catch {
      // 计数只是展示用，失败就沿用上一次的估计，下一轮再试。
    }
    finally {
      this.nextCountAt = this.now() + Math.max(MIN_COUNT_INTERVAL_MS, busyMs * COUNT_COST_FACTOR)
    }
  }

  /** 剩余量：见文件头注的三层来源。到点了就在后台排一次计数，本身从不等它。 */
  private remaining(now: number): number | null {
    if (this.state === 'idle')
      return 0
    if (!this.counting && (this.counted === null || now >= this.nextCountAt)) {
      const run = countChain.then(() => this.recount())
      countChain = run
      this.counting = run.finally(() => {
        this.counting = null
      })
    }
    return this.counted === null ? null : Math.max(0, this.counted - (this.sessionDone - this.countBase))
  }

  private rate(now: number): number | null {
    this.batches = this.batches.filter(b => now - b.end <= RATE_WINDOW_MS)
    if (!this.batches.length)
      return null
    const span = (this.batches.at(-1)!.end - this.batches[0]!.start) / 1000
    const done = this.batches.reduce((s, b) => s + b.done, 0)
    return span > 0 ? done / span : null
  }

  snapshot(): LoopStatus {
    const now = this.now()
    const remaining = this.remaining(now)
    const ratePerSecond = this.state === 'idle' ? null : this.rate(now)
    return {
      key: this.key,
      queue: this.queue,
      state: this.state,
      remaining,
      processed: this.processed,
      failed: this.failed,
      sessionDone: this.sessionDone,
      ratePerSecond,
      etaSeconds: remaining !== null && ratePerSecond ? Math.round(remaining / ratePerSecond) : null,
      batchStartedAt: this.batchStartedAt,
      lastBatchAt: this.lastBatchAt,
      lastError: this.lastError,
    }
  }
}

const trackers: LoopTracker[] = []
let schedulerError: string | null = null

export function registerLoop(key: string, queue: string, counter: PendingCounter): LoopTracker {
  const tracker = new LoopTracker(key, queue, counter)
  trackers.push(tracker)
  return tracker
}

/**
 * 调度器启动失败（`index.ts` 的启动重试每失败一次报一次），成功后传 `null` 清掉。
 * 前端据此显示"调度未运行"和原因，而不是一片空白。
 */
export function setSchedulerError(err: unknown): void {
  schedulerError = err === null ? null : String(err)
}

export function schedulerStatus(): { running: boolean, error: string | null, loops: LoopStatus[] } {
  return {
    running: trackers.length > 0,
    error: schedulerError,
    loops: trackers.map(t => t.snapshot()),
  }
}
