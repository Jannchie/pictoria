/**
 * 测试库：一个跑完全部迁移的 `:memory:` 连接。
 *
 * 和生产库走同一个 `createDb`（sqlite-vec 扩展、`foreign_keys = ON`、同一套 PRAGMA），
 * 所以 vec0 虚表、FK 级联、触发器在测试里和线上是同一份行为。内存库上
 * `journal_mode = WAL` 会被 SQLite 静默降成 `memory`，对单连接的测试没有区别。
 *
 * 每次调用都是一个全新的库 —— 内存库不跨连接共享，测试之间天然隔离，也不用清理
 * 临时文件（Windows 上漏关一个句柄就删不掉临时目录）。用完 `close()` 即可。
 */
import type { SqliteHandle } from './connection.js'
import { createDb } from './connection.js'
import { MIGRATIONS_DIR, runMigrations } from './migrate.js'

// 包外的测试（`apps/api`）也要造 post 和向量：复用 db 包自己测试用的那几个，不另写一份。
export { insertPost, insertVector, unitBlob } from './__fixtures__/testdb.js'

export function createTestDb(): SqliteHandle {
  const { sqlite } = createDb({ path: ':memory:' })
  runMigrations(sqlite, MIGRATIONS_DIR)
  return sqlite
}
