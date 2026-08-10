/**
 * 进程级的单个 SQLite 连接。
 *
 * better-sqlite3 是同步的，不存在"连接被并发请求抢占"的问题 —— Node 的事件循环
 * 天然把查询串行化。所以这里一个连接就够，不需要连接池（Python 侧要 thread-local
 * 连接是因为它把同步调用扔进了线程池）。
 */
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '@pictoria/db'

/**
 * 仓库根 —— 从本文件位置推出来，而不是靠 `process.cwd()`。
 *
 * cwd 取决于从哪儿启动（`pnpm --filter` 会把 cwd 设成包目录），拿它解析相对路径
 * 会得到 `apps/api/server/illustration/...` 这种不存在的路径。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 供其它模块解析仓库内相对路径。 */
export function repoRoot(): string {
  return REPO_ROOT
}

let handle: ReturnType<typeof createDb> | null = null

/** 与 Python 侧 app.py 的解析规则一致：DB_PATH 覆盖 `<target_dir>/.pictoria/`。 */
function resolvePath(): string {
  const override = process.env.DB_PATH
  if (override)
    return override
  const targetDir = process.env.PICTORIA_TARGET_DIR ?? 'server/illustration/images'
  return path.resolve(REPO_ROOT, targetDir, '.pictoria/pictoria.sqlite')
}

export function getDb() {
  handle ??= createDb({ path: resolvePath() })
  return handle
}

export function closeDb(): void {
  handle?.sqlite.close()
  handle = null
}
