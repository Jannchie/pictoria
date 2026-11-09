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

import { BACKFILL_WORKERS } from '@pictoria/db'
import { yieldToEventLoop } from './event-loop.js'

/**
 * 后台循环的 key，按启动顺序 —— 就是 `@pictoria/db` 的 `BACKFILL_WORKERS`（silva 家族
 * 每个打分器一条，由 `SCORERS` 生成）。`/v2/queues/status` 的字段说明和启动日志都从这里取。
 */
export const BACKFILL_LOOP_KEYS = BACKFILL_WORKERS

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

/** 全部循环共用的计数串行链，理由见文件头注第 2 条。 */
let countChain: Promise<void> = Promise.resolve()

/**
 * 一段忙碌期（上次扫空之后）的全部记账。扫空就整个扔掉，下一段从一个新对象开始 ——
 * 进度、速度窗口、上次计数的结果都只属于它所在的那一段，没有"扫空时忘了清哪个字段"
 * 这回事；后台计数也靠对象身份判断自己数的那一段是否还在（见 `recount`）。
 */
interface Session {
  /** 这一段已经完成的条数 —— 进度条的分子。 */
  done: number
  batches: Batch[]
  /** 上一次精确计数的结果；`null` = 这一段还没数过。 */
  counted: number | null
  /** 那次计数开始时的 `done` —— 剩余 = counted − 此后完成的。 */
  countBase: number
}

/**
 * 循环所处的阶段。`error` 不是单独一段：出错时积压还在、这一段的进度也还算数，所以它是
 * 忙碌期上的一个标记，下一批成功就摘掉。
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'busy', session: Session, error: string | null }

function newSession(): Session {
  return { done: 0, batches: [], counted: null, countBase: 0 }
}

export class LoopTracker {
  private phase: Phase = { kind: 'idle' }
  private processed = 0
  private failed = 0
  /** 正在跑的那一批的开始时间；与阶段正交（扫空之后的下一次待办查询也是"一批"）。 */
  private batchStartedAt: number | null = null
  private lastBatchAt: number | null = null
  private nextCountAt = 0
  private counting: Promise<void> | null = null

  constructor(
    readonly key: string,
    readonly queue: string,
    private readonly counter: PendingCounter,
    private readonly now: () => number = Date.now,
  ) {}

  /** 当前这一段；扫空状态下开一段新的（积压是新冒出来的，"精确的 0"已经过期）。 */
  private currentSession(): Session {
    return this.phase.kind === 'busy' ? this.phase.session : newSession()
  }

  /** 一批开始（待办查询之前）。 */
  begin(): void {
    this.batchStartedAt = this.now()
  }

  /** 一批落库完成：`done` 条写进去了，`failed` 条被拉黑（都可能是 0 —— 一批没推进）。 */
  record(done: number, failed: number): void {
    const end = this.now()
    const total = done + failed
    const session = this.currentSession()
    this.processed += done
    this.failed += failed
    session.done += total
    session.batches.push({ start: this.batchStartedAt ?? end, end, done: total })
    this.batchStartedAt = null
    this.lastBatchAt = end
    this.phase = { kind: 'busy', session, error: null }
  }

  /** 待办查询扫空：此刻没有待办。速度只描述一段忙碌期，所以整段扔掉。 */
  idle(): void {
    this.batchStartedAt = null
    this.phase = { kind: 'idle' }
  }

  /** 这一批抛了。扫空之后的第一批就抛的话也算进入忙碌：查询都没跑完，谈不上"没有待办"。 */
  error(err: unknown): void {
    this.batchStartedAt = null
    this.phase = { kind: 'busy', session: this.currentSession(), error: String(err) }
  }

  /** 进行中（或排队中）的那次后台计数；没有就立即 resolve。测试用来等计数落定。 */
  settled(): Promise<void> {
    return this.counting ?? Promise.resolve()
  }

  private async recount(session: Session): Promise<void> {
    const base = session.done
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
      // 计数途中扫空过的话，这一段已经被扔掉了，写回去也没人读 —— 新一段自己会重数。
      session.counted = total
      // 计数期间落库的那些，一部分在已数过的块里（已经不在 total 里），一部分还没数到；
      // 一律当成"之后落库的"继续递减，误差不超过计数期间完成的条数。
      session.countBase = base
    }
    catch {
      // 计数只是展示用，失败就沿用上一次的估计，下一轮再试。
    }
    finally {
      this.nextCountAt = this.now() + Math.max(MIN_COUNT_INTERVAL_MS, busyMs * COUNT_COST_FACTOR)
    }
  }

  /** 剩余量：见文件头注的三层来源。到点了就在后台排一次计数，本身从不等它。 */
  private remaining(session: Session, now: number): number | null {
    if (!this.counting && (session.counted === null || now >= this.nextCountAt)) {
      const run = countChain.then(() => this.recount(session))
      countChain = run
      this.counting = run.finally(() => {
        this.counting = null
      })
    }
    return session.counted === null ? null : Math.max(0, session.counted - (session.done - session.countBase))
  }

  private rate(session: Session, now: number): number | null {
    session.batches = session.batches.filter(b => now - b.end <= RATE_WINDOW_MS)
    const { batches } = session
    if (!batches.length)
      return null
    const span = (batches.at(-1)!.end - batches[0]!.start) / 1000
    const done = batches.reduce((s, b) => s + b.done, 0)
    return span > 0 ? done / span : null
  }

  snapshot(): LoopStatus {
    const now = this.now()
    const common = {
      key: this.key,
      queue: this.queue,
      processed: this.processed,
      failed: this.failed,
      batchStartedAt: this.batchStartedAt,
      lastBatchAt: this.lastBatchAt,
    }
    if (this.phase.kind === 'idle') {
      // 扫空 = 精确的 0，不用数。
      return { ...common, state: 'idle', remaining: 0, sessionDone: 0, ratePerSecond: null, etaSeconds: null, lastError: null }
    }
    const { session, error } = this.phase
    const remaining = this.remaining(session, now)
    const ratePerSecond = this.rate(session, now)
    return {
      ...common,
      state: error === null ? 'working' : 'error',
      remaining,
      sessionDone: session.done,
      ratePerSecond,
      etaSeconds: remaining !== null && ratePerSecond ? Math.round(remaining / ratePerSecond) : null,
      lastError: error,
    }
  }
}

const trackers: LoopTracker[] = []

/**
 * 后台调度器本身的阶段（`index.ts` 在启动流程的每一步报一次）。原来是一个
 * `error: string | null` 加上"登记过循环 = 在跑"的推断，于是"已关闭""还在连""连不上、
 * 正在重试"三种情况在前端长得一样，而"循环起来了、之后的启动步骤抛了"会显示成一切正常、
 * 错误被吞掉。
 */
export type SchedulerState =
  /** `PICTORIA_SCHEDULER=0`：只跑 HTTP，这是刻意的。 */
  | { kind: 'disabled' }
  /** 正在开任务库（第一次尝试还没结束）。 */
  | { kind: 'starting' }
  /** 开任务库失败，正在退避重试。 */
  | { kind: 'retrying', error: string }
  | { kind: 'running' }
  /** 启动流程抛了、不会再重试 —— 可能已经有一部分循环在跑，但不完整。 */
  | { kind: 'failed', error: string }

let scheduler: SchedulerState = { kind: 'starting' }

export function registerLoop(key: string, queue: string, counter: PendingCounter): LoopTracker {
  const tracker = new LoopTracker(key, queue, counter)
  trackers.push(tracker)
  return tracker
}

export function setSchedulerState(state: SchedulerState): void {
  scheduler = state
}

export function schedulerStatus(): { state: SchedulerState['kind'], error: string | null, loops: LoopStatus[] } {
  return {
    state: scheduler.kind,
    error: 'error' in scheduler ? scheduler.error : null,
    loops: trackers.map(t => t.snapshot()),
  }
}
