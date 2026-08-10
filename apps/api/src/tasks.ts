/**
 * cairnq 客户端句柄。
 *
 * **`tasks.sqlite` 是独立文件，不和图库共用**（§4.3）。SQLite 一次只允许一个写者，
 * 而 cairnq 的租约续约和心跳是高频小写 —— 正好是那种会挡在图库正常写前面、让它
 * 排队的流量。分文件之后两者各写各的。
 */
import process from 'node:process'
import path from 'node:path'
import { CairnQ } from 'cairnq'
import { repoRoot } from './db.js'

let handle: CairnQ | null = null

/** 与 Python worker 的 `tasks_db_path()` 同规则。 */
export function resolveTasksDbPath(): string {
  const override = process.env.TASKS_DB_PATH
  if (override)
    return override
  const targetDir = process.env.PICTORIA_TARGET_DIR ?? 'server/illustration/images'
  return path.resolve(repoRoot(), targetDir, '.pictoria/tasks.sqlite')
}

export async function getTasks(): Promise<CairnQ> {
  if (!handle) {
    handle = CairnQ.sqlite(resolveTasksDbPath())
    await handle.connect()
  }
  return handle
}

export async function closeTasks(): Promise<void> {
  await handle?.close()
  handle = null
}
