/**
 * SQLite 连接 —— 逐条复刻 Python 侧 `db/connection.py` 的配置。
 *
 * 这里的每一个 PRAGMA 都对应那边的一行。少一条就是行为漂移：少了
 * `foreign_keys = ON`，级联删除会静默失效（子表留下孤儿行，且没有任何报错）；
 * 少了 `journal_mode = WAL`，读会被写阻塞。
 */
import fs from 'node:fs'
import nodePath from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
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
  // 父目录不存在时 better-sqlite3 直接抛 "Cannot open database because the
  // directory does not exist" —— 而库目录本来就是这个进程负责建的。承自 Python 侧
  // `DB.__init__` 的 `self.path.parent.mkdir(parents=True, exist_ok=True)`，迁移时
  // 漏掉了这一行，表现是新 clone 或换一个 `PICTORIA_TARGET_DIR` 就起不来。
  // 只读连接不建：那是"打开一个已存在的库"的语义，目录不在就该报错。
  if (!readonly)
    fs.mkdirSync(nodePath.dirname(nodePath.resolve(path)), { recursive: true })

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

  return { sqlite }
}
