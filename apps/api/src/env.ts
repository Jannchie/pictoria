/**
 * 路由拿依赖的唯一入口：Hono 的 context 变量。
 *
 * 路由不 import 任何进程级单例 —— 库连接和 cairnq 句柄由 `createApp({ db, tasks })`
 * 的中间件 `c.set()` 进来，handler 里用 `c.var.db` / `c.var.tasks` 取。生产环境放的是
 * `db.ts` 的 `getDb()` 和 `tasks.ts` 的 `getTasks()`/`peekTasks()`；测试放一个跑完迁移
 * 的内存库和一个假的 tasks（见 `testing/app.ts`）。
 *
 * 类型经 `OpenAPIHono<AppEnv>` 传进每个 handler 的 `c`：每个路由文件都用 `newRoutes()`
 * 建实例，忘了泛型的话 `c.var.db` 直接编译不过，而不是在运行期拿到 `undefined`。
 */
import type { CairnQ } from 'cairnq'
import type { SqliteHandle } from '@pictoria/db'
import { OpenAPIHono } from '@hono/zod-openapi'
import { zodErrorHook } from './openapi.js'

/**
 * cairnq 句柄的来源，而不是句柄本身。
 *
 * 生产上开 `tasks.sqlite` 是惰性的、可能失败的（`tasks.ts` 的注释讲了为什么失败不重试）；
 * 一个只碰库的请求不该因为任务库开不了而失败，所以注入的是"需要时去拿"。
 */
export interface TaskSource {
  /** 拿到（必要时打开）cairnq 句柄。交互端点用：开库失败就让这个请求失败。 */
  get: () => Promise<CairnQ>
  /** 已经连上的句柄，没连上是 `null` —— 绝不触发开库。只读状态展示用。 */
  peek: () => CairnQ | null
}

export interface AppVariables {
  db: SqliteHandle
  tasks: TaskSource
}

export interface AppEnv {
  Variables: AppVariables
}

/** 一个路由文件的实例：带上 `AppEnv`，挂上统一的 zod 错误翻译。 */
export function newRoutes() {
  return new OpenAPIHono<AppEnv>({ defaultHook: zodErrorHook })
}
