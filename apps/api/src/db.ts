/**
 * 进程级的单个 SQLite 连接。
 *
 * better-sqlite3 是同步的，不存在"连接被并发请求抢占"的问题 —— Node 的事件循环
 * 天然把查询串行化。所以这里一个连接就够，不需要连接池（Python 侧要 thread-local
 * 连接是因为它把同步调用扔进了线程池）。
 */
import { createDb, runMigrations } from '@pictoria/db'
import { dbPath, migrationsDir } from './paths.js'

let handle: ReturnType<typeof createDb> | null = null

export function getDb() {
  if (!handle) {
    handle = createDb({ path: dbPath() })
    // ⚠️ 这一句是 Litestar 退役时接过来的。此前**只有** `app.py` 在启动时跑迁移，
    // Hono 侧一次都没跑过 —— 代理还在的时候两个进程都开着，所以没人发现。删掉
    // Litestar 而不接这一棒，下一个 `server/migrations/NNNN_*.sql` 会静默地永远
    // 不被应用：表不存在，报错出现在第一个碰到新列的查询上，离原因很远。
    // 幂等，已应用的版本记在 `_schema_versions`。
    const applied = runMigrations(handle.sqlite, migrationsDir())
    if (applied)
      console.warn(`[pictoria-api] 应用了 ${applied} 个迁移`)
  }
  return handle
}

export function closeDb(): void {
  handle?.sqlite.close()
  handle = null
}
