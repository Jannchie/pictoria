/**
 * 进程级的单个 SQLite 连接。
 *
 * better-sqlite3 是同步的，不存在"连接被并发请求抢占"的问题 —— Node 的事件循环
 * 天然把查询串行化。所以这里一个连接就够，不需要连接池（Python 侧要 thread-local
 * 连接是因为它把同步调用扔进了线程池）。
 */
import { createDb } from '@pictoria/db'
import { dbPath } from './paths.js'

let handle: ReturnType<typeof createDb> | null = null

export function getDb() {
  handle ??= createDb({ path: dbPath() })
  return handle
}


export function closeDb(): void {
  handle?.sqlite.close()
  handle = null
}
