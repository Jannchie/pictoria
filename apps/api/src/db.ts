/**
 * 进程级的单个 SQLite 连接。
 *
 * better-sqlite3 是同步的，不存在"连接被并发请求抢占"的问题 —— Node 的事件循环
 * 天然把查询串行化。所以这里一个连接就够，不需要连接池（Python 侧要 thread-local
 * 连接是因为它把同步调用扔进了线程池）。
 */
import { createDb, MIGRATIONS_DIR, runMigrations } from '@pictoria/db'
import { dbPath } from './paths.js'

let handle: ReturnType<typeof createDb> | null = null

export function getDb() {
  handle ??= createDb({ path: dbPath() })
  return handle
}

/**
 * 应用待执行的迁移。**由 `index.ts` 在 `serve()` 之前显式调用一次。**
 *
 * 这一棒是 Litestar 退役时接过来的：此前只有 `app.py` 在启动时跑迁移，Hono 侧一次
 * 都没跑过——代理还在的时候两个进程都开着，所以没人发现。不接的话，下一个
 * `server/migrations/NNNN_*.sql` 会静默地永远不被应用，报错出现在第一个碰到新列的
 * 查询上，离原因很远。
 *
 * ⚠️ 刻意**不**放在 `getDb()` 里。放进去的话它就变成"谁先碰库谁触发 DDL"：
 * `PICTORIA_SCHEDULER=0` 时启动路径根本不碰库，迁移会落到第一个请求里；更糟的是
 * `routes/statistics.test.ts` 经 `getDb()` 连的是**生产库**，于是 `pnpm test` 会对
 * 22 万行的真实库执行 DDL。schema 变更必须是一个有人明确发起的启动步骤。
 *
 * 幂等，已应用的版本记在 `_schema_versions`。
 */
export function migrate(): void {
  const applied = runMigrations(getDb().sqlite, MIGRATIONS_DIR)
  if (applied)
    console.warn(`[pictoria-api] 应用了 ${applied} 个迁移`)
}

export function closeDb(): void {
  handle?.sqlite.close()
  handle = null
}
