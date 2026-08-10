/**
 * SQLite 连接 —— 逐条复刻 Python 侧 `db/connection.py` 的配置。
 *
 * 这里的每一个 PRAGMA 都对应那边的一行。少一条就是行为漂移：少了
 * `foreign_keys = ON`，级联删除会静默失效（子表留下孤儿行，且没有任何报错）；
 * 少了 `journal_mode = WAL`，读会被写阻塞。
 */
import process from 'node:process'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type PictoriaDatabase = ReturnType<typeof createDb>['db']

export interface OpenOptions {
  /** SQLite 文件路径。 */
  path: string
  /** 只读打开（分析脚本用）。只读连接不设写相关 PRAGMA。 */
  readonly?: boolean
}

/**
 * 打开一个连接并按 pictoria 的约定配置好。
 *
 * 顺序有讲究：扩展要在任何 vec0 语句之前加载；`foreign_keys` 必须每连接单独设
 * （它不是数据库级持久设置）；`journal_mode = WAL` 是持久的，但重复设置无害。
 */
export function createDb({ path, readonly = false }: OpenOptions) {
  const sqlite = new Database(path, { readonly, fileMustExist: readonly })

  // vec0 虚表和 vec_distance_L2 都依赖它，必须最先加载。
  sqliteVec.load(sqlite)

  // 连接级，且不持久 —— 每条新连接都要重设，否则 ON DELETE CASCADE 静默失效。
  sqlite.pragma('foreign_keys = ON')

  // 拿不到写锁时等 30 秒再报错，对齐 Python 侧 `sqlite3.connect(timeout=30.0)`。
  // better-sqlite3 默认只等 5 秒 —— 一次全库对账加上一批 backfill 落库就能超过它，
  // 而外部脚本（对拍、分析）撞上这个窗口拿到的是 SQLITE_BUSY 而不是稍等一下。
  sqlite.pragma('busy_timeout = 30000')

  if (!readonly) {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('temp_store = MEMORY')
    // 30 GB 上限，OS 会按实际内存夹紧。让 22 万行的向量表尽量走 page cache。
    sqlite.pragma('mmap_size = 30000000000')
  }

  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * 默认库路径：`<target_dir>/.pictoria/pictoria.sqlite`，可被 `DB_PATH` 覆盖 ——
 * 和 Python 侧 `app.py` 的解析规则一致。
 */
export function resolveDbPath(targetDir: string): string {
  const override = process.env.DB_PATH
  if (override)
    return override
  return `${targetDir}/.pictoria/pictoria.sqlite`
}
