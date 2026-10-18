/**
 * 读线程的入口（由 `read-pool.ts` 起，不要直接 import）。
 *
 * 开一条**只读**连接，按消息里的函数名调 `READ_FNS`（`read-fns.ts`）里登记的查询，
 * 把结果原样发回去。只读是 SQLite 层面的硬保证（`SQLITE_OPEN_READONLY`），不靠约定：
 * 哪天有人往白名单里加了一个会写的函数，它会当场报 "attempt to write a readonly
 * database"，而不是悄悄变出第二个写者。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { ReadReply, ReadRequest } from './read-pool.js'
import { parentPort, workerData } from 'node:worker_threads'
import { createDb } from '@pictoria/db'
import { READ_FNS } from './read-fns.js'

const { dbPath } = workerData as { dbPath: string }
const { sqlite } = createDb({ path: dbPath, readonly: true })

parentPort!.on('message', ({ id, fn, args }: ReadRequest) => {
  try {
    // 自有键才放行：消息里的名字是外来数据，`toString` / `constructor` 这类原型上的名字
    // 不能被当成函数调。这一行就是"只是白名单，不是任意执行器"的保证。
    if (!Object.hasOwn(READ_FNS, fn))
      throw new Error(`读线程不认识的函数：${String(fn)}`)
    const handler = READ_FNS[fn] as (db: SqliteHandle, ...a: unknown[]) => unknown
    // postMessage 也在 try 里：结果里混进不可克隆的值会抛 DataCloneError，那该是这个
    // 请求失败，而不是整个线程崩掉重启。
    parentPort!.postMessage({ id, ok: true, value: handler(sqlite, ...args) } satisfies ReadReply)
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
