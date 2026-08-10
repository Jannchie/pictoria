/**
 * 迁移执行器 —— 和 Python 侧 `db/migrator.py` 同语义。
 *
 * 迁移文件是 `server/migrations/NNNN_*.sql`，按文件名排序执行，已应用的版本记在
 * `_schema_versions` 里。**这里不生成 SQL，只执行现成的** —— 15 个迁移已经在生产库
 * 跑完，两侧必须看到同一套文件，否则就会有两套 schema 真理。
 */
import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

const VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS _schema_versions (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`

/** 从 `0003_last_accessed_at.sql` 取出 `0003_last_accessed_at`。 */
function versionOf(file: string): string {
  return path.basename(file, '.sql')
}

export function listMigrations(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => path.join(dir, f))
}

/**
 * 应用尚未执行的迁移，返回本次应用的条数。
 *
 * 每个文件在自己的事务里跑：一个迁移要么整体生效，要么整体不生效。注意
 * better-sqlite3 的 `exec()` 允许多语句，但不隐式开事务 —— 得自己包。
 */
export function runMigrations(sqlite: BetterSqlite3.Database, dir: string): number {
  sqlite.exec(VERSION_TABLE)

  const applied = new Set(
    sqlite
      .prepare<[], { version: string }>('SELECT version FROM _schema_versions')
      .all()
      .map(r => r.version),
  )

  const record = sqlite.prepare('INSERT INTO _schema_versions (version) VALUES (?)')
  let count = 0

  for (const file of listMigrations(dir)) {
    const version = versionOf(file)
    if (applied.has(version))
      continue

    const script = fs.readFileSync(file, 'utf8')
    sqlite.transaction(() => {
      sqlite.exec(script)
      record.run(version)
    })()
    count++
  }

  return count
}
