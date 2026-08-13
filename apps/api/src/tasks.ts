/**
 * cairnq 客户端句柄。
 *
 * **`tasks.sqlite` 是独立文件，不和图库共用**（§4.3）。SQLite 一次只允许一个写者，
 * 而 cairnq 的租约续约和心跳是高频小写 —— 正好是那种会挡在图库正常写前面、让它
 * 排队的流量。分文件之后两者各写各的。
 */
import { CairnQ } from 'cairnq'
import { tasksDbPath } from './paths.js'

let handle: CairnQ | null = null

export async function getTasks(): Promise<CairnQ> {
  if (!handle) {
    handle = CairnQ.sqlite(tasksDbPath())
    await handle.connect()
  }
  return handle
}

export async function closeTasks(): Promise<void> {
  await handle?.close()
  handle = null
}
