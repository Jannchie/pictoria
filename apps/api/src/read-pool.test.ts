/**
 * 读线程池：结果和主线程直接调一致、并发都能回来、线程出错/崩溃只影响手上那一个请求。
 *
 * 线程池的用例跑**真实线程**：线程开的是自己的只读连接，所以库得是磁盘上的文件
 * （内存库不跨连接共享）。线程入口是 `.ts`，靠 `read-pool.ts` 给它的 `--import tsx`
 * 加载 —— vitest 自己的进程里没有 tsx，这条路径在这里被真实走到。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { Reads } from './read-pool.js'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb, createTestDb, insertPost, insertVector, knn, MIGRATIONS_DIR, runMigrations, searchByTextVector, unitBlob } from '@pictoria/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createReadPool, inProcessReads } from './read-pool.js'

const POSTS = 40

/** 文搜图的查询向量：和库里 post 的向量同一个生成器，换成 Float32Array。 */
function unitVector(seed: number): Float32Array {
  const b = unitBlob(seed)
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

function seed(sqlite: SqliteHandle): void {
  for (let id = 1; id <= POSTS; id++) {
    insertPost(sqlite, { id })
    insertVector(sqlite, id)
  }
}

describe('inProcessReads', () => {
  it('已 abort 的 signal 不执行', async () => {
    const sqlite = createTestDb()
    const ctl = new AbortController()
    ctl.abort()
    await expect(inProcessReads(sqlite).withSignal(ctl.signal).countPosts({})).rejects.toMatchObject({ name: 'AbortError' })
    sqlite.close()
  })

  it('与直接调 @pictoria/db 一致', async () => {
    const sqlite = createTestDb()
    seed(sqlite)
    const reads = inProcessReads(sqlite)
    expect(await reads.knn(3, 10)).toEqual(knn(sqlite, 3, 10))
    expect(await reads.searchByTextVector(unitVector(7), {}, { limit: 5 }))
      .toEqual(searchByTextVector(sqlite, unitVector(7), {}, { limit: 5 }))
    await reads.close()
    sqlite.close()
  })
})

// 真实工作线程：每个池子冷启动都要经 tsx 转译整个 @pictoria/db，负载高时会超过默认的 5 s。
describe('createReadPool（真实线程）', { timeout: 20_000 }, () => {
  let dir: string
  let dbFile: string
  let reference: SqliteHandle

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-read-pool-'))
    dbFile = path.join(dir, 'pictoria.sqlite')
    const { sqlite } = createDb({ path: dbFile })
    runMigrations(sqlite, MIGRATIONS_DIR)
    seed(sqlite)
    reference = sqlite
  })

  afterAll(() => {
    reference.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('并发请求都正确返回（比线程多，走排队）', async () => {
    const pool = createReadPool({ dbPath: dbFile, size: 2 })
    try {
      const ids = Array.from({ length: 8 }, (_, i) => i + 1)
      const results = await Promise.all(ids.map(id => pool.knn(id, 10)))
      for (const [i, id] of ids.entries()) expect(results[i]).toEqual(knn(reference, id, 10))

      const text = await pool.searchByTextVector(unitVector(11), {}, { limit: 5 })
      expect(text).toEqual(searchByTextVector(reference, unitVector(11), {}, { limit: 5 }))
    }
    finally {
      await pool.close()
    }
  })

  it('查询抛错只让那个请求 reject，池子照常可用', async () => {
    const pool = createReadPool({ dbPath: dbFile, size: 1 })
    try {
      // 维度不对：vec0 当场报错。
      await expect(pool.searchByTextVector(new Float32Array(3), {}, { limit: 5 })).rejects.toThrow(/dimension/i)
      expect(await pool.knn(2, 5)).toEqual(knn(reference, 2, 5))
    }
    finally {
      await pool.close()
    }
  })

  /**
   * 假线程：包住真读线程的 message 监听，`intercept` 是一段 JS，拿到消息 `m` 和真监听
   * `fn`，自己决定怎么处理。包 `on` 而不是另挂一个监听：端口在第一个监听挂上时就开始
   * 投递，真线程的监听还在加载（tsx 转译）时到达的消息会丢。MessagePort 也没有
   * prependListener。
   */
  function wrappedEntry(name: string, prelude: string, intercept: string): { url: URL, execArgv: string[] } {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const file = path.join(dir, `${name}.mjs`)
    const realWorker = new URL('./read-worker.ts', import.meta.url).href
    fs.writeFileSync(file, [
      `import { parentPort } from 'node:worker_threads'`,
      prelude,
      `const on = parentPort.on.bind(parentPort)`,
      `parentPort.on = (ev, fn) => on(ev, ev === 'message' ? (m) => { ${intercept} } : fn)`,
      `await import(${JSON.stringify(realWorker)})`,
    ].join('\n'))
    return { url: pathToFileURL(file), execArgv: ['--import', tsx] }
  }

  it('线程崩溃时手上的请求 reject，补位的新线程接着干活', async () => {
    // 种子是 -1 就 process.exit(3)，否则照常处理。
    const pool: Reads = createReadPool({
      dbPath: dbFile,
      size: 1,
      entry: wrappedEntry('crashing-worker', '', 'if (m.args[0] === -1) process.exit(3); fn(m)'),
    })
    try {
      const doomed = pool.knn(-1, 5)
      const queued = pool.knn(4, 5)
      await expect(doomed).rejects.toThrow(/exit code 3/)
      expect(await queued).toEqual(knn(reference, 4, 5))
    }
    finally {
      await pool.close()
    }
  })

  it('同参数的并发 knn 只派一次线程，结束后不再复用', async () => {
    // 线程数一数自己收到了几个请求；种子 -2 是探针，直接回这个数，不计入、不查库。
    const pool = createReadPool({
      dbPath: dbFile,
      size: 1,
      entry: wrappedEntry(
        'counting-worker',
        'let seen = 0',
        'if (m.args[0] === -2) parentPort.postMessage({ id: m.id, ok: true, value: seen }); else { seen++; fn(m) }',
      ),
    })
    const seen = async () => (await pool.knn(-2, 0)) as unknown as number
    try {
      const [a, b] = await Promise.all([pool.knn(5, 10), pool.knn(5, 10)])
      expect(a).toEqual(knn(reference, 5, 10))
      // 同一个对象：两个调用拿的是同一个 Promise 的结果。
      expect(b).toBe(a)
      expect(await seen()).toBe(1)

      // 上一次已经结束，key 已删：同样的调用会重新派一次。
      await pool.knn(5, 10)
      expect(await seen()).toBe(2)
    }
    finally {
      await pool.close()
    }
  })

  /** 线程里睡 `ms`（同步）：模拟一个正在跑的重查询。 */
  const sleep = (ms: number) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})`

  it('慢通道的重计数挡不住快通道的 KNN', async () => {
    const pool = createReadPool({
      dbPath: dbFile,
      size: 1,
      slowSize: 1,
      entry: wrappedEntry('slow-lane-worker', '', `if (m.fn === 'countAllTags') ${sleep(1500)}; fn(m)`),
    })
    try {
      const order: string[] = []
      const slow = pool.countAllTags({ rating: [0] }).then(() => order.push('countAllTags'))
      const fast = pool.knn(3, 5).then((r) => {
        order.push('knn')
        return r
      })
      expect(await fast).toEqual(knn(reference, 3, 5))
      await slow
      expect(order).toEqual(['knn', 'countAllTags'])
    }
    finally {
      await pool.close()
    }
  })

  it('已 abort 的不派发；排队中被 abort 的出队；去重合并的要所有等待者都放弃', async () => {
    const pool = createReadPool({
      dbPath: dbFile,
      size: 1,
      slowSize: 0,
      entry: wrappedEntry(
        'abort-worker',
        'let seen = 0',
        `if (m.args[0] === -2) { parentPort.postMessage({ id: m.id, ok: true, value: seen }); return } seen++; if (m.args[0] === -5) ${sleep(400)}; fn(m)`,
      ),
    })
    const seen = async () => (await pool.knn(-2, 0)) as unknown as number
    try {
      const gone = new AbortController()
      gone.abort()
      await expect(pool.withSignal(gone.signal).knn(1, 5)).rejects.toMatchObject({ name: 'AbortError' })
      expect(await seen()).toBe(0)

      // 线程被 -5 占着 400 ms；排在后面的那个在排队时被放弃。
      const busy = pool.knn(-5, 5)
      const queued = new AbortController()
      const p = pool.withSignal(queued.signal).knn(2, 5)
      queued.abort()
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
      await busy
      expect(await seen()).toBe(1) // 只有 -5 被派发过

      // 同参数两个等待者：一个放弃，另一个照样拿到结果，而且只派发一次。
      const blocker = pool.knn(-5, 6)
      const one = new AbortController()
      const a = pool.withSignal(one.signal).countPosts({ rating: [0] })
      const b = pool.countPosts({ rating: [0] })
      one.abort()
      await expect(a).rejects.toMatchObject({ name: 'AbortError' })
      expect(await b).toBe(POSTS)
      await blocker
      expect(await seen()).toBe(3) // 两个 -5 + 一次 countPosts
    }
    finally {
      await pool.close()
    }
  })

  it('正在跑的读被放弃时，线程能从取消字读到（分块的读据此提前停下）', async () => {
    const pool = createReadPool({
      dbPath: dbFile,
      size: 1,
      slowSize: 1,
      entry: wrappedEntry(
        'cancel-word-worker',
        `import { workerData } from 'node:worker_threads'
let lastCancelled = null`,
        `if (m.args[0] === -3) { parentPort.postMessage({ id: m.id, ok: true, value: lastCancelled }); return }`
        + ` if (m.fn === 'countAllTags') { ${sleep(300)}; lastCancelled = Atomics.load(workerData.cancel, 0) === m.id }`
        + ` fn(m)`,
      ),
    })
    try {
      const ctl = new AbortController()
      const p = pool.withSignal(ctl.signal).countAllTags({ rating: [0] })
      await new Promise(resolve => setTimeout(resolve, 50))
      ctl.abort()
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
      // 探针和 countAllTags 都在慢通道那一条线程上：它回来时 countAllTags 已经跑完。
      const probe = pool.countAllTags(-3 as never)
      expect(await probe).toBe(true)
    }
    finally {
      await pool.close()
    }
  })

  it('同参数的并发计数只派一次线程', async () => {
    const pool = createReadPool({
      dbPath: dbFile,
      size: 1,
      slowSize: 0,
      entry: wrappedEntry(
        'counting-count-worker',
        'let seen = 0',
        'if (m.args[0] === -2) parentPort.postMessage({ id: m.id, ok: true, value: seen }); else { seen++; fn(m) }',
      ),
    })
    try {
      const [a, b, c] = await Promise.all([pool.countPosts({}), pool.countPosts({}), pool.countPosts({ rating: [1] })])
      expect([a, b, c]).toEqual([POSTS, POSTS, 0])
      expect(await pool.knn(-2, 0)).toBe(2)
    }
    finally {
      await pool.close()
    }
  })

  it('close() 之后的调用直接 reject', async () => {
    const pool = createReadPool({ dbPath: dbFile, size: 1 })
    await pool.close()
    await expect(pool.knn(1, 5)).rejects.toThrow(/已关闭/)
  })
})
