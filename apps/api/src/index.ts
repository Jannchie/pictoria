import type { CairnQ } from 'cairnq'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { rebuildGroups } from './dedup.js'
import { SILVA_SCORERS } from '@pictoria/contracts'
import { getDb, migrate } from './db.js'
import { fail } from './openapi.js'
import { setSchedulerError } from './queue-status.js'
import { startBasicsBackfill, startEmbeddingBackfill, startSilvaBackfill, startTaggerBackfill, startWaifuBackfill, wakeAllBackfills } from './scheduler.js'
import { startAutoSync } from './sync.js'
import { getTasks } from './tasks.js'
import { annotationQueuesRoutes } from './routes/annotation-queues.js'
import { annotationsRoutes } from './routes/annotations.js'
import { commandsRoutes } from './routes/commands.js'
import { foldersRoutes } from './routes/folders.js'
import { imagesRoutes } from './routes/images.js'
import { postCountsRoutes } from './routes/post-counts.js'
import { postListRoutes } from './routes/post-list.js'
import { postReadsRoutes } from './routes/post-reads.js'
import { postWritesRoutes } from './routes/post-writes.js'
import { queuesRoutes } from './routes/queues.js'
import { statisticsRoutes } from './routes/statistics.js'
import { tagsRoutes } from './routes/tags.js'
import { tagWritesRoutes } from './routes/tag-writes.js'

/**
 * Pictoria API。
 *
 * 全部端点都在这里。契约的守卫是 `pnpm contract:check`：从活的 API 重新生成前端
 * 客户端，和已提交的有 diff 就失败。从 Litestar 迁过来的记录在
 * `docs/refactor-monorepo-hono.md`。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)
const app = new OpenAPIHono()

/**
 * CORS —— 前端在 4778，API 在 4777，每一个请求都是跨源的。
 *
 * ⚠️ 没有自动守卫：测试和 genapi 都不带 `Origin` 头，改这一段要在浏览器里手测一次
 * 预检。`allowHeaders` 显式列出而不是留空让 Hono 回显请求头 —— 浏览器看来等价，
 * 但显式的那份在响应里是稳定的。
 */
app.use('*', cors({
  origin: '*',
  allowMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
  allowHeaders: ['Accept', 'Accept-Language', 'Content-Language', 'Content-Type'],
  maxAge: 600,
}))

// 按 content-type 白名单压缩：不压 JPEG/PNG（已经是压缩格式，实测省 0.2% 纯烧
// CPU），也跳过 206。
app.use('*', compress())

app.route('/', statisticsRoutes)
app.route('/', queuesRoutes)
app.route('/', foldersRoutes)
app.route('/', tagsRoutes)
app.route('/', tagWritesRoutes)
app.route('/', annotationsRoutes)
app.route('/', annotationQueuesRoutes)
app.route('/', commandsRoutes)
app.route('/', imagesRoutes)
// ⚠️ 顺序有意义：Hono 按注册顺序匹配，字面量路径必须排在带参数的前面。
// postWrites 里有 /v2/posts/bulk/*，若排在 /v2/posts/{post_id}/* 之后，
// "bulk" 会被当成 post_id 去 coerce 成 NaN。
app.route('/', postCountsRoutes)
app.route('/', postWritesRoutes)
app.route('/', postListRoutes)
app.route('/', postReadsRoutes)

/** `/schema/openapi.json` —— 前端 `pnpm genapi` 打的就是这个地址。 */
app.get('/schema/openapi.json', (c) => {
  const local = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Pictoria', version: '0.1.0' },
  })

  // hey-api 把组件的 `title` 转成 TS 类型上的 JSDoc，zod-openapi 不产出这个字段，
  // 缺了 genapi 的产物会少掉 260 行注释 —— 类型不变，但编辑器里的悬停提示会空掉。
  // 统一在这里补，比在 50 处手写可靠。
  for (const [name, schema] of Object.entries(local.components?.schemas ?? {})) {
    const s = schema as Record<string, unknown>
    s.title ??= name
  }

  return c.json(local)
})

// 没有路由匹配时的 404 和没被路由接住的异常：Hono 默认回纯文本，前端的错误处理
// 只认 `ErrorBody`。500 的细节进日志不进响应。
app.notFound(() => fail(404, 'NotFound', 'Not Found'))
app.onError((err) => {
  console.error(`[pictoria-api] 未处理的异常：${err.stack ?? String(err)}`)
  return fail(500, 'InternalServerError', 'Internal Server Error')
})

// schema 先于流量：迁移失败就不该开始服务，否则第一批请求会打在半旧的 schema 上。
migrate()

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.warn(`[pictoria-api] listening on http://127.0.0.1:${info.port}`)
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
      setSchedulerError(null)
      return tasks
    }
    catch (err) {
      // 带上整个 err（堆栈 + code）：只打 String(err) 时分不清是哪一步失败的。
      console.error(`[pictoria-api] 后台调度开库失败，${delay / 1000}s 后重试（HTTP 服务不受影响）：`, err)
      setSchedulerError(err)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

if (process.env.PICTORIA_SCHEDULER !== '0') {
  void (async () => {
    const tasks = await tasksForScheduler()
    const { sqlite } = getDb()
    // basics 排在最前：其余 worker 的输入（尺寸、缩略图）都由它产出。
    startBasicsBackfill(sqlite, tasks)
    for (const scorer of SILVA_SCORERS)
      startSilvaBackfill(sqlite, tasks, { scorer })
    startWaifuBackfill(sqlite, tasks)
    startTaggerBackfill(sqlite, tasks)
    // embedding 的待办清空之后要重建近重复分组 —— 新图不经过这一步就永远不会被
    // 认成任何一张老图的重复（形状承自已删除的 EMBEDDING_WORKER.on_backfill_complete）。
    startEmbeddingBackfill(sqlite, tasks, {
      onDrained: async () => {
        await rebuildGroups(sqlite, tasks).catch((err: unknown) =>
          console.warn(`[dedup] 重建失败：${String(err)}`))
      },
    })
    // 磁盘变化和定时轮询都会触发一次对账，然后把 backfill 循环叫醒 ——
    // 形状承自已删除的 app.py 里的 watchdog + 10 分钟 poller。
    startAutoSync(sqlite, () => wakeAllBackfills())
    console.warn('[pictoria-api] backfill 调度已启动：basics, silva, silva_luna, waifu, tagger, embedding')
    console.warn('[pictoria-api] 文件监视 + 10 分钟轮询已启动')
  })().catch((err: unknown) => {
    // ⚠️ 这个 catch 不能省。上面整段是 fire-and-forget，开库之后的启动步骤抛出的
    // 异常会一路冒到这里 —— Node 默认 `--unhandled-rejections=throw`，于是一个**已经
    // 绑好端口、70 个端点都能正常服务**的进程会被一个后台初始化失败直接干掉。退役掉的
    // app.py 每条后台循环都包了 try/except，就是这个原因。
    console.error('[pictoria-api] 后台调度启动失败，HTTP 服务继续：', err)
    // 也报给前端的同步状态区：只有一行终端日志的话，调度停了很久都没人发现。
    setSchedulerError(err)
  })
}
