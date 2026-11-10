import type { CairnQ } from 'cairnq'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { getDb, migrate } from './db.js'
import { rebuilderFor } from './dedup.js'
import { OPTIMIZE_INTERVAL_MS, optimizeDb } from './optimize.js'
import { BACKFILL_LOOP_KEYS, setSchedulerState } from './queue-status.js'
import { dbPath, targetDir } from './paths.js'
import { createReadPool, inProcessReads, readThreadsFromEnv } from './read-pool.js'
import { FolderTree } from './routes/folders.js'
import { startBackfills } from './scheduler.js'
import { startAutoSync } from './sync.js'
import { getTasks, peekTasks } from './tasks.js'

/**
 * Pictoria API 的进程入口 —— **只做启动副作用**：跑迁移、`serve()`、起 backfill 调度器和
 * 文件监视。中间件、路由、OpenAPI 文档的组装在 `app.ts` 的 `createApp`，那里不碰任何
 * 进程级单例，测试直接拿它造 app。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)

/**
 * 默认只绑 IPv4 回环。不写 hostname 时 Node 绑的是 `::`（所有网卡），局域网里谁都能
 * 读写整个图库。`PICTORIA_API_HOST` 显式改（如 `0.0.0.0`）—— 那时记得把前端的源加进
 * `PICTORIA_ALLOWED_ORIGINS`，否则 Host / Origin 闸门（`security.ts`）会拒掉它。
 *
 * 前端直连 `http://localhost:4777`：浏览器解析 localhost 时 `::1` 连不上会回落到
 * 127.0.0.1，所以不需要同时绑 `::1`。
 */
const HOST = process.env.PICTORIA_API_HOST || '127.0.0.1'

// schema 先于流量：迁移失败就不该开始服务，否则第一批请求会打在半旧的 schema 上。
migrate()

// 统计信息先于流量：表规模自上次 ANALYZE 以来变了一个数量级的话，在这里重新分析，
// 否则首页排序会退回 TEMP B-TREE（见 `optimize.ts`）。没变化时是毫秒级空操作。之后每小时
// 一次，追上导入 / 打标 / sync 批量增删带来的增长。读线程在这之后才起，
// 打开连接时读到的就是新统计。
optimizeDb(getDb().sqlite)
setInterval(() => {
  try {
    optimizeDb(getDb().sqlite)
  }
  catch (err) {
    console.error('[pictoria-api] PRAGMA optimize 失败（不影响服务）：', err)
  }
}, OPTIMIZE_INTERVAL_MS).unref()

// 相似图 / 文搜图的整库 KNN 放到读线程上（见 `read-pool.ts`）。迁移之后再起：线程开的是
// 只读连接，跑不了 DDL，得看到迁移完的 schema。`PICTORIA_READ_THREADS=0` 退回主线程，
// 用来二分定位线程那边的问题。线程是 unref 的，进程退出时随之结束，不需要单独关。
const readThreads = readThreadsFromEnv()
const reads = readThreads > 0
  ? createReadPool({ dbPath: dbPath(), size: readThreads })
  : inProcessReads(getDb().sqlite)

// 目录树挂文件监视：之后的 `/v2/folders` 只重读变了的目录（见 `routes/folders.ts`）。
// 启动时先在后台冷走一遍，第一次点开侧边栏就不用等。
const folderTree = new FolderTree({ watch: true })
folderTree.warm(targetDir())

const app = createApp({ db: getDb().sqlite, tasks: { get: getTasks, peek: peekTasks }, reads, folderTree })

// 回收上一个进程留下的近重复临时矩阵（被杀 / 超时，一个 1–2 GB）。还被 worker 占着的
// 删不掉，跳过；本进程正在用的由 `DedupRebuilder` 记着，不会被删。
void rebuilderFor(getDb().sqlite).sweepStale()

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const shown = info.family === 'IPv6' ? `[${info.address}]` : info.address
  console.warn(`[pictoria-api] listening on http://${shown}:${info.port}`)
})

// ---- backfill 调度（§D2：挑活在 TS，干活在 Python worker） ----
// 默认开着 —— 这是迁移的目标状态。设 PICTORIA_SCHEDULER=0 可以整个停掉，用来二分定位。
/**
 * 调度器的任务库句柄：开库失败就退避重试（2 秒起、翻倍、封顶 1 分钟），一直重试下去。
 *
 * 调度器只在启动时开一次库，失败一次就整段不启动、只剩 HTTP。失败的原因里有真实
 * 发生过的暂时性问题（2026-09-24 升 cairnq 0.15 后第一次 `pnpm dev`，开库撞上另一个
 * 进程的写锁，等满 busy_timeout），也有要等 worker 那边跟上的问题（协议版本对不上）
 * —— 两种都是"过一会儿再试"就能好，不值得让人去重启 API。每次失败都报给前端的
 * 同步状态区，成功后清掉。
 *
 * 重试放在这里而不是 `getTasks()` 里：交互端点（缩略图、打标、转图）要的是快速失败。
 */
async function tasksForScheduler(): Promise<CairnQ> {
  for (let delay = 2_000; ; delay = Math.min(delay * 2, 60_000)) {
    try {
      const tasks = await getTasks()
      return tasks
    }
    catch (err) {
      // 带上整个 err（堆栈 + code）：只打 String(err) 时分不清是哪一步失败的。
      console.error(`[pictoria-api] 后台调度开库失败，${delay / 1000}s 后重试（HTTP 服务不受影响）：`, err)
      setSchedulerState({ kind: 'retrying', error: String(err) })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

if (process.env.PICTORIA_SCHEDULER !== '0') {
  void (async () => {
    const tasks = await tasksForScheduler()
    const { sqlite } = getDb()
    // 按 `workers.ts` 的 BACKFILL_SPECS 起全部循环（basics 排在最前：其余 worker 的
    // 输入 —— 尺寸、缩略图 —— 都由它产出）。embedding 待办清空后的近重复重组是它
    // 规格上的 `onDrained`。
    startBackfills(sqlite, tasks)
    // 磁盘变化和定时轮询都会触发一次对账 —— 形状承自已删除的 app.py 里的 watchdog +
    // 10 分钟 poller。建出新行时 `insertPostTriples` 自己叫醒 backfill 循环。
    startAutoSync(sqlite)
    console.warn(`[pictoria-api] backfill 调度已启动：${BACKFILL_LOOP_KEYS.join(', ')}`)
    console.warn('[pictoria-api] 文件监视 + 10 分钟轮询已启动')
    setSchedulerState({ kind: 'running' })
  })().catch((err: unknown) => {
    // ⚠️ 这个 catch 不能省。上面整段是 fire-and-forget，开库之后的启动步骤抛出的
    // 异常会一路冒到这里 —— Node 默认 `--unhandled-rejections=throw`，于是一个**已经
    // 绑好端口、70 个端点都能正常服务**的进程会被一个后台初始化失败直接干掉。退役掉的
    // app.py 每条后台循环都包了 try/except，就是这个原因。
    console.error('[pictoria-api] 后台调度启动失败，HTTP 服务继续：', err)
    // 也报给前端的同步状态区：只有一行终端日志的话，调度停了很久都没人发现。
    setSchedulerState({ kind: 'failed', error: String(err) })
  })
}
else {
  setSchedulerState({ kind: 'disabled' })
}
