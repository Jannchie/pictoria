/**
 * 重读查询的线程池：把整库向量 KNN 挪出事件循环。
 *
 * better-sqlite3 是同步的。`/v2/posts/{id}/similar` 的 vec0 `MATCH ... k=N` 是暴力扫描，
 * 34 万行 FLOAT[1152] 在主线程上跑 1.5–3 秒 —— 这期间**整个**进程不响应任何请求（实测
 * 并发一个 404 探针要等 1.49 s）。前端单选一张图后改评分，`PUT .../score` 就排在它后面。
 * 文本搜索的 `searchByTextVector` 是同一类扫描。
 *
 * 做法：`node:worker_threads` 起几个线程，每个开**自己的只读连接**（WAL 下读不阻塞写、
 * 也不被写阻塞，读到的是已提交数据），主线程按消息派发。线程里能调的只有
 * `read-fns.ts` 登记的那几个函数（读线程按它校验）—— 这不是一个任意 SQL 执行器，
 * 写永远留在主线程那一条连接上。
 *
 * 路由经 `c.var.reads` 拿（`env.ts`）。测试和 `PICTORIA_READ_THREADS=0` 用
 * `inProcessReads`：同一组函数在主线程同步执行，包成 Promise。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { ReadArgs, ReadFnName, ReadResult } from './read-fns.js'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { READ_FN_NAMES, READ_FNS } from './read-fns.js'

/** 每个登记的读函数一个异步方法（去掉连接参数），外加 `close`。由 `READ_FNS` 生成。 */
export type Reads = { [K in ReadFnName]: (...args: ReadArgs<K>) => Promise<ReadResult<K>> } & {
  close: () => Promise<void>
}

/** 主线程 → 读线程。 */
export interface ReadRequest {
  id: number
  fn: ReadFnName
  args: unknown[]
}

/** 读线程 → 主线程。错误只带可克隆的字段：Error 实例的自有属性过结构化克隆会丢。 */
export type ReadReply
  = | { id: number, ok: true, value: unknown }
    | { id: number, ok: false, error: { name: string, message: string, stack?: string, code?: string } }

type Invoke = (fn: ReadFnName, args: unknown[]) => Promise<unknown>

/**
 * 按 `READ_FN_NAMES` 生成方法对象。类型的对应在 `Reads` 的映射类型里，运行时这里只是
 * 按名字转发 —— 所以要一次断言。
 */
function buildReads(invoke: Invoke, close: () => Promise<void>): Reads {
  const methods: Record<string, unknown> = { close }
  for (const fn of READ_FN_NAMES)
    methods[fn] = (...args: unknown[]) => invoke(fn, args)
  return methods as Reads
}

/** 在当前线程同步执行，包成 Promise。测试、兜底、`PICTORIA_READ_THREADS=0` 用。 */
export function inProcessReads(db: SqliteHandle): Reads {
  // async：同步抛的错也变成 reject，和线程池那边的行为一致。
  return buildReads(
    async (fn, args) => (READ_FNS[fn] as (db: SqliteHandle, ...a: unknown[]) => unknown)(db, ...args),
    async () => {},
  )
}

const DEFAULT_READ_THREADS = 2

/**
 * 读线程数：`PICTORIA_READ_THREADS` 覆盖默认的 2，`0` 表示不起线程。
 *
 * 默认 2 而不是按核数：一次 KNN 就把 30 GB mmap 下的向量表整段扫一遍，瓶颈是内存
 * 带宽，线程开多了只是一起慢；两条够让"打开详情的 similar"不被前一个没跑完的排住。
 */
export function readThreadsFromEnv(): number {
  const raw = process.env.PICTORIA_READ_THREADS
  if (raw === undefined || raw.trim() === '')
    return DEFAULT_READ_THREADS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[pictoria-api] PICTORIA_READ_THREADS=${raw} 不是非负整数，用默认的 ${DEFAULT_READ_THREADS}`)
    return DEFAULT_READ_THREADS
  }
  return n
}

/**
 * 线程入口和它的 loader。
 *
 * 入口跟着本文件的扩展名走：现在 `dev` / `start` 都是 tsx 直接跑 `.ts`（没有产出 `.js`
 * 的构建），哪天加了构建，编译后的 `read-pool.js` 会去找同目录的 `read-worker.js`。
 *
 * `.ts` 入口必须显式 `--import tsx`，不能指望继承 `process.execArgv`：vitest 的进程里
 * 根本没有 tsx（它自己转译），`tsx src/index.ts` 起的进程里 execArgv 又是 tsx 内部的
 * loader 路径；`dev` 的 `--watch` 继承进线程也没有意义。从本文件解析 tsx 的绝对路径，
 * 不受 cwd 影响。注意 `@pictoria/db` 的 exports 指的是 `.ts` 源码 —— 真加了构建，
 * 线程那边也得能加载它。
 */
function workerEntry(): { url: URL, execArgv: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    return { url: new URL('./read-worker.ts', import.meta.url), execArgv: ['--import', tsx] }
  }
  return { url: new URL('./read-worker.js', import.meta.url), execArgv: [] }
}

interface Job {
  req: ReadRequest
  resolve: (value: any) => void
  reject: (err: unknown) => void
}

interface Slot {
  worker: Worker
  job: Job | null
  /** 连续崩溃次数：拿到一次正常回复就清零。用来给重启退避。 */
  crashes: number
}

export interface ReadPoolOptions {
  dbPath: string
  /** 线程数，≥ 1。`0` 的语义（不起线程）由调用方处理：那时没有路径可开，见 `index.ts`。 */
  size: number
  /** 测试用：换一个线程入口（比如一个按需自杀的假线程）。生产不传。 */
  entry?: { url: URL, execArgv: string[] }
}

function errorFromReply(e: Extract<ReadReply, { ok: false }>['error']): Error {
  const err = new Error(e.message) as Error & { code?: string }
  err.name = e.name
  if (e.code !== undefined)
    err.code = e.code
  // 线程那边的堆栈才有用：主线程这边只会是 message 处理器。
  if (e.stack)
    err.stack = e.stack
  return err
}

export function createReadPool({ dbPath, size, entry = workerEntry() }: ReadPoolOptions): Reads {
  if (!Number.isInteger(size) || size < 1)
    throw new Error(`createReadPool: size 必须是正整数，拿到 ${size}`)

  const queue: Job[] = []
  const slots: Slot[] = []
  let nextId = 1
  let closed = false

  function spawn(crashes: number): Slot {
    const worker = new Worker(entry.url, { workerData: { dbPath }, execArgv: entry.execArgv })
    // 线程不该把进程吊着不退出：API 有 serve() 撑着，脚本/测试忘了 close() 也能正常结束。
    worker.unref()
    const slot: Slot = { worker, job: null, crashes }

    worker.on('message', (reply: ReadReply) => {
      const job = slot.job
      if (!job || job.req.id !== reply.id)
        return
      slot.job = null
      slot.crashes = 0
      if (reply.ok)
        job.resolve(reply.value)
      else
        job.reject(errorFromReply(reply.error))
      dispatch()
    })

    // 线程里没接住的异常（含启动时开库失败）：先来 'error'，紧接着 'exit'。
    worker.on('error', (err) => {
      console.error('[pictoria-api] 读线程崩溃：', err)
      failJob(slot, err)
    })

    worker.on('exit', (code) => {
      const index = slots.indexOf(slot)
      if (index !== -1)
        slots.splice(index, 1)
      if (closed)
        return
      failJob(slot, new Error(`读线程意外退出（exit code ${code}）`))
      respawn(slot.crashes + 1)
    })

    slots.push(slot)
    return slot
  }

  function failJob(slot: Slot, err: unknown) {
    const job = slot.job
    slot.job = null
    job?.reject(err)
  }

  /**
   * 补一个线程。第一次崩溃立即补；连续崩溃（典型是库文件打不开，每个新线程一启动
   * 就死）按 250 ms 起翻倍退避、封顶 5 秒 —— 不退避就是一个吃满一核的重启循环。
   * 退避期间排队的请求等着，下一个线程一起来照样会接走、再失败就 reject，不会吊死。
   */
  function respawn(crashes: number) {
    const delay = crashes <= 1 ? 0 : Math.min(250 * 2 ** (crashes - 2), 5_000)
    const timer = setTimeout(() => {
      if (closed)
        return
      spawn(crashes)
      dispatch()
    }, delay)
    timer.unref()
  }

  /** 空闲线程优先；都忙就留在队里，先来先走。 */
  function dispatch() {
    for (const slot of slots) {
      if (!queue.length)
        return
      if (slot.job)
        continue
      const job = queue.shift()!
      slot.job = job
      slot.worker.postMessage(job.req)
    }
  }

  function call(fn: ReadFnName, args: unknown[]): Promise<unknown> {
    if (closed)
      return Promise.reject(new Error('读线程池已关闭'))
    return new Promise((resolve, reject) => {
      queue.push({ req: { id: nextId++, fn, args }, resolve, reject })
      dispatch()
    })
  }

  /**
   * 同参数的并发调用共用一个 Promise，只派一次线程。
   *
   * 只对 `knn` 做：同一张图的 similar 撞在一起（来回切图、重复打开）时，每一次都是
   * 1.5–3 秒的整表扫描，白扫一遍就是排在后面的请求再多等一遍；它的参数是两个数字，
   * 拼 key 不花钱。`searchByTextVector` 的参数里有 Float32Array，JSON.stringify 出来是
   * 按下标展开的对象，又贵又难得重复，不做。结果是共享的同一个对象，调用方不能改它。
   */
  const inflight = new Map<string, Promise<unknown>>()
  const invoke: Invoke = (fn, args) => {
    if (fn !== 'knn')
      return call(fn, args)
    const key = fn + JSON.stringify(args)
    const hit = inflight.get(key)
    if (hit)
      return hit
    const p = call(fn, args)
    inflight.set(key, p)
    const forget = () => inflight.delete(key)
    p.then(forget, forget)
    return p
  }

  for (let i = 0; i < size; i++)
    spawn(0)

  return buildReads(invoke, async () => {
    if (closed)
      return
    closed = true
    const err = new Error('读线程池已关闭')
    for (const job of queue.splice(0))
      job.reject(err)
    const running = [...slots]
    for (const slot of running)
      failJob(slot, err)
    await Promise.all(running.map(s => s.worker.terminate()))
  })
}
