/**
 * 读线程池：结果和主线程直接调一致、并发都能回来、线程出错/崩溃只影响手上那一个请求。
 *
 * 线程池的用例跑**真实线程**：线程开的是自己的只读连接，所以库得是磁盘上的文件
 * （内存库不跨连接共享）。线程入口是 `.ts`，靠 `read-pool.ts` 给它的 `--import tsx`
 * 加载 —— vitest 自己的进程里没有 tsx，这条路径在这里被真实走到。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { Reads } from './read-pool.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb, createTestDb, knn, MIGRATIONS_DIR, runMigrations, searchByTextVector, SIGLIP2_DIM, upsertVectors } from '@pictoria/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createReadPool, inProcessReads } from './read-pool.js'

const POSTS = 40

/** 确定性的伪随机单位向量：每个 id 一个，测试之间可复现。 */
function unitVector(seed: number): Float32Array {
  const v = new Float32Array(SIGLIP2_DIM)
  let x = seed * 2654435761 % 2 ** 32
  let norm = 0
  for (let i = 0; i < v.length; i++) {
    x = (x * 1664525 + 1013904223) % 2 ** 32
    v[i] = x / 2 ** 32 - 0.5
    norm += v[i]! * v[i]!
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < v.length; i++) v[i]! /= norm
  return v
}

function seed(sqlite: SqliteHandle): void {
  const ins = sqlite.prepare('INSERT INTO posts (file_path, file_name, extension) VALUES (?, ?, ?)')
  const rows: Array<{ postId: number, embedding: Buffer }> = []
  for (let i = 1; i <= POSTS; i++) {
    const id = Number(ins.run('.', `p${i}`, 'png').lastInsertRowid)
    const v = unitVector(i)
    rows.push({ postId: id, embedding: Buffer.from(v.buffer, v.byteOffset, v.byteLength) })
  }
  upsertVectors(sqlite, rows)
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

describe('createReadPool（真实线程）', () => {
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

  it('线程崩溃时手上的请求 reject，补位的新线程接着干活', async () => {
    // 假线程：包住真读线程的 message 监听 —— 种子是 -1 就 process.exit(3)，否则照常处理。
    // 包 `on` 而不是另挂一个监听：端口在第一个监听挂上时就开始投递，真线程的监听还在
    // 加载（tsx 转译）时到达的消息会丢。MessagePort 也没有 prependListener。
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const crashing = path.join(dir, 'crashing-worker.mjs')
    const realWorker = new URL('./read-worker.ts', import.meta.url).href
    fs.writeFileSync(crashing, [
      `import { parentPort } from 'node:worker_threads'`,
      `const on = parentPort.on.bind(parentPort)`,
      `parentPort.on = (ev, fn) => on(ev, ev === 'message' ? (m) => { if (m.args[0] === -1) process.exit(3); fn(m) } : fn)`,
      `await import(${JSON.stringify(realWorker)})`,
    ].join('\n'))

    const pool: Reads = createReadPool({
      dbPath: dbFile,
      size: 1,
      entry: { url: pathToFileURL(crashing), execArgv: ['--import', tsx] },
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

  it('close() 之后的调用直接 reject', async () => {
    const pool = createReadPool({ dbPath: dbFile, size: 1 })
    await pool.close()
    await expect(pool.knn(1, 5)).rejects.toThrow(/已关闭/)
  })
})
