/**
 * 迁移执行器 —— 和 Python 侧 `db/migrator.py` 同语义。
 *
 * 迁移文件是 `server/migrations/NNNN_*.sql`，按文件名排序执行，已应用的版本记在
 * `_schema_versions` 里。**这里不生成 SQL，只执行现成的** —— 15 个迁移已经在生产库
 * 跑完，两侧必须看到同一套文件，否则就会有两套 schema 真理。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * 迁移文件所在目录。
 *
 * 和 `runMigrations` 放在同一个文件，是因为"迁移在哪"和"怎么跑迁移"是同一件知识：
 * 此前它散在 `apps/api/src/paths.ts` 和三个测试各自手写的 `../../../../server/migrations`
 * 里，共四份相对路径，挪窝时 API 正常启动而三个测试同时失效。
 *
 * 仍在 `server/` 下：15 个迁移是按文件名记在生产库 `_schema_versions` 里的，改名等于
 * 重跑。目录归属和文件位置是两件事，这里只统一前者。
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../server/migrations',
)

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
 *
 * 迁移期间 `foreign_keys` 整体关掉 —— 这是 SQLite 文档对"重建被外键引用的表"给出的
 * 唯一流程（改 CHECK 只能重建；事务内改不了 foreign_keys，deferred 计数器又会被
 * DROP 旧父表时的隐式删除卡死，2026-08 实测两条弯路都走不通）。换来的保护不是没了
 * 而是换了位置：每个迁移提交后立即 `foreign_key_check`，有悬空引用就抛错 —— 违规的
 * 迁移被点名，而不是靠逐行约束在中途拦截。结束后恢复调用方原来的设置。
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

  const fkWasOn = (sqlite.pragma('foreign_keys', { simple: true }) as number) === 1
  sqlite.pragma('foreign_keys = OFF')
  try {
    for (const file of listMigrations(dir)) {
      const version = versionOf(file)
      if (applied.has(version))
        continue

      const script = fs.readFileSync(file, 'utf8')
      sqlite.transaction(() => {
        sqlite.exec(script)
        record.run(version)
      })()
      const dangling = sqlite.pragma('foreign_key_check') as unknown[]
      if (dangling.length)
        throw new Error(`migration ${version} left dangling foreign keys: ${JSON.stringify(dangling.slice(0, 3))}`)
      count++
    }
  }
  finally {
    if (fkWasOn)
      sqlite.pragma('foreign_keys = ON')
  }

  return count
}
