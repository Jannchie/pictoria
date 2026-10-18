/**
 * 重读查询的线程池：把整库向量 KNN 挪出事件循环。
 *
 * better-sqlite3 是同步的。`/v2/posts/{id}/similar` 的 vec0 `MATCH ... k=N` 是暴力扫描，
 * 34 万行 FLOAT[1152] 在主线程上跑 1.5–3 秒 —— 这期间**整个**进程不响应任何请求（实测
 * 并发一个 404 探针要等 1.49 s）。前端单选一张图后改评分，`PUT .../score` 就排在它后面。
 * 文本搜索的 `searchByTextVector` 是同一类扫描。
 *
 * 做法：`node:worker_threads` 起几个线程，每个开**自己的只读连接**（WAL 下读不阻塞写、
 * 也不被写阻塞，读到的是已提交数据），主线程按消息派发。线程里能调的只有下面
 * `Reads` 列出的两个函数（`read-worker.ts` 的白名单）—— 这不是一个任意 SQL 执行器，
 * 写永远留在主线程那一条连接上。
 *
 * 路由经 `c.var.reads` 拿（`env.ts`）。测试和 `PICTORIA_READ_THREADS=0` 用
 * `inProcessReads`：同一组函数在主线程同步执行，包成 Promise。
 */
import type { PostFilter, SqliteHandle } from '@pictoria/db'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { knn, searchByTextVector } from '@pictoria/db'

type SearchOptions = NonNullable<Parameters<typeof searchByTextVector>[3]>

export interface Reads {
  knn: (seedPostId: number, k: number) => Promise<Array<[number, number]>>
  searchByTextVector: (vector: Float32Array, filter: PostFilter, opts: SearchOptions) => Promise<ReturnType<typeof searchByTextVector>>
  close: () => Promise<void>
}

/** 线程里允许调的函数名。和 `read-worker.ts` 的 `HANDLERS` 一一对应。 */
export type ReadFn = Exclude<keyof Reads, 'close'>

/** 主线程 → 读线程。 */
export interface ReadRequest {
  id: number
  fn: ReadFn
  args: unknown[]
}

/** 读线程 → 主线程。错误只带可克隆的字段：Error 实例的自有属性过结构化克隆会丢。 */
export type ReadReply
  = | { id: number, ok: true, value: unknown }
    | { id: number, ok: false, error: { name: string, message: string, stack?: string, code?: string } }

/** 在当前线程同步执行，包成 Promise。测试、兜底、`PICTORIA_READ_THREADS=0` 用。 */
export function inProcessReads(db: SqliteHandle): Reads {
  return {
    knn: async (seedPostId, k) => knn(db, seedPostId, k),
    searchByTextVector: async (vector, filter, opts) => searchByTextVector(db, vector, filter, opts),
    close: async () => {},
  }
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
  id: number
  fn: ReadFn
  args: unknown[]
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
  size?: number
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

export function createReadPool({ dbPath, size = DEFAULT_READ_THREADS, entry = workerEntry() }: ReadPoolOptions): Reads {
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
      if (!job || job.id !== reply.id)
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
      slot.worker.postMessage({ id: job.id, fn: job.fn, args: job.args } satisfies ReadRequest)
    }
  }

  function call<T>(fn: ReadFn, args: unknown[]): Promise<T> {
    if (closed)
      return Promise.reject(new Error('读线程池已关闭'))
    return new Promise<T>((resolve, reject) => {
      queue.push({ id: nextId++, fn, args, resolve, reject })
      dispatch()
    })
  }

  for (let i = 0; i < size; i++)
    spawn(0)

  return {
    knn: (seedPostId, k) => call('knn', [seedPostId, k]),
    searchByTextVector: (vector, filter, opts) => call('searchByTextVector', [vector, filter, opts]),
    close: async () => {
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
    },
  }
}
