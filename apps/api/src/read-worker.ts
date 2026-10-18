/**
 * 读线程的入口（由 `read-pool.ts` 起，不要直接 import）。
 *
 * 开一条**只读**连接，按消息里的函数名调白名单里的查询，把结果原样发回去。只读是
 * SQLite 层面的硬保证（`SQLITE_OPEN_READONLY`），不靠约定：哪天有人往白名单里加了
 * 一个会写的函数，它会当场报 "attempt to write a readonly database"，而不是悄悄变出
 * 第二个写者。
 */
import type { ReadReply, ReadRequest } from './read-pool.js'
import { parentPort, workerData } from 'node:worker_threads'
import { createDb, knn, searchByTextVector } from '@pictoria/db'

const { dbPath } = workerData as { dbPath: string }
const { sqlite } = createDb({ path: dbPath, readonly: true })

const HANDLERS: Record<ReadRequest['fn'], (...args: any[]) => unknown> = {
  knn: (seedPostId: number, k: number) => knn(sqlite, seedPostId, k),
  searchByTextVector: (vector: Float32Array, filter, opts) => searchByTextVector(sqlite, vector, filter, opts),
}

parentPort!.on('message', ({ id, fn, args }: ReadRequest) => {
  try {
    if (!Object.hasOwn(HANDLERS, fn))
      throw new Error(`读线程不认识的函数：${String(fn)}`)
    // postMessage 也在 try 里：结果里混进不可克隆的值会抛 DataCloneError，那该是这个
    // 请求失败，而不是整个线程崩掉重启。
    parentPort!.postMessage({ id, ok: true, value: HANDLERS[fn](...args) } satisfies ReadReply)
  }
  catch (err) {
    parentPort!.postMessage(errorReply(id, err))
  }
})

function errorReply(id: number, err: unknown): ReadReply {
  const e = err instanceof Error ? err : new Error(String(err))
  const code = (e as { code?: unknown }).code
  return { id, ok: false, error: { name: e.name, message: e.message, stack: e.stack, code: typeof code === 'string' ? code : undefined } }
}
