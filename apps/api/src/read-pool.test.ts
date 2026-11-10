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

  it('close() 之后的调用直接 reject', async () => {
    const pool = createReadPool({ dbPath: dbFile, size: 1 })
    await pool.close()
    await expect(pool.knn(1, 5)).rejects.toThrow(/已关闭/)
  })
})
