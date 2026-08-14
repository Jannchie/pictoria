import process from 'node:process'
import { serve } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { rebuildGroups } from './dedup.js'
import { SILVA_SCORERS } from '@pictoria/contracts'
import { getDb, migrate } from './db.js'
import { httpError } from './openapi.js'
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
import { statisticsRoutes } from './routes/statistics.js'
import { tagsRoutes } from './routes/tags.js'
import { tagWritesRoutes } from './routes/tag-writes.js'

/**
 * Pictoria API。
 *
 * 70 个端点全部在这里。反向代理和 Litestar 参照实现都已删除 —— 迁移期它们分别负责
 * 透传未搬完的路由、以及给 12 套对拍当基准，两件事在 70/70 之后都失去了意义。
 *
 * 契约现在由 `pnpm contract:diff`（对 `docs/openapi.baseline.json`）单独守着，那是
 * 唯一还活着的守卫；退役前最后一次全量对拍的记录在 `docs/refactor-monorepo-hono.md`
 * 的 Phase 7。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)
const app = new OpenAPIHono()

/**
 * CORS —— 前端在 4778，API 在 4777，每一个请求都是跨源的。
 *
 * ⚠️ 迁移期间这件事是**隐形**的：响应头由代理从 Litestar 透传回来，所以浏览器一直
 * 是通的；端点搬成原生 Hono 之后就断了。对拍套件全程没发现，因为它们不带 `Origin`
 * 头 —— 后来补了专门的检查，但那套脚本已随参照实现一起退役。改这一段没有自动守卫，
 * 要手测一次预检。
 *
 * 配置对齐退役前 Litestar 的 `CORSConfig(allow_origins=["*"])` 实测输出：预检 204 +
 * max-age 600 + 七个方法 + 四个安全头。`allowHeaders` 显式列出而不是留空让 Hono
 * 回显请求头 —— 两者在浏览器看来等价，但显式的那份在响应里是稳定的，好对拍。
 */
app.use('*', cors({
  origin: '*',
  allowMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
  allowHeaders: ['Accept', 'Accept-Language', 'Content-Language', 'Content-Type'],
  maxAge: 600,
}))

// 按 content-type 白名单压缩：不压 JPEG/PNG（已经是压缩格式，实测省 0.2% 纯烧
// CPU —— Litestar 那边不分类型全压，这里是有意的差别），也跳过 206。
app.use('*', compress())

app.route('/', statisticsRoutes)
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

/**
 * `/schema/openapi.json` —— 前端 `pnpm genapi` 打的就是这个地址。
 *
 * 迁移期这里要把本地和上游 Litestar 的 schema 合起来。那段已经删掉：退役前实测
 * 过，把上游指向死端口起一个实例，本地这一份自己就是 70 个操作、与 baseline 逐项
 * 相同。合并唯一的实际效果是在参照实现跑着时用它的组件补上本地缺的，也就是
 * **掩盖** `contract:diff` 本该报出来的缺口。
 */
app.get('/schema/openapi.json', (c) => {
  const local = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Pictoria', version: '0.1.0' },
  })

  // Litestar 给每个组件都带 `title`（恒等于组件名），hey-api 把它转成 TS 类型上的
  // JSDoc。zod-openapi 不产出这个字段，缺了会让 genapi 的产物少掉 260 行注释 ——
  // 类型不变，但编辑器里的悬停提示会空掉。统一在这里补，比在 50 处手写可靠。
  for (const [name, schema] of Object.entries(local.components?.schemas ?? {})) {
    const s = schema as Record<string, unknown>
    s.title ??= name
  }

  return c.json(local)
})

/**
 * 没有路由匹配时的 404。
 *
 * Hono 默认回一句纯文本 `404 Not Found`，Litestar 回的是
 * `{"status_code":404,"detail":"Not Found"}`。代理还在的时候这个差别被藏住了
 * （未匹配的一律透传），删掉代理才露出来。前端的错误处理认 JSON 那一种。
 */
app.notFound(() => httpError(404, 'Not Found'))

/**
 * 没被路由自己接住的异常。
 *
 * Hono 默认回纯文本 `Internal Server Error`，两种契约错误形状都不是，前端一律
 * 解析失败。Litestar 的 500 是 `{"status_code":500,"detail":"Internal Server
 * Error"}`，这里对齐它。细节进日志不进响应 —— 和 Litestar 的 debug=False 一致。
 */
app.onError((err) => {
  console.error(`[pictoria-api] 未处理的异常：${err.stack ?? String(err)}`)
  return httpError(500, 'Internal Server Error')
})

// schema 先于流量：迁移失败就不该开始服务，否则第一批请求会打在半旧的 schema 上。
migrate()

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.warn(`[pictoria-api] listening on http://127.0.0.1:${info.port}`)
})

// ---- backfill 调度（§D2：挑活在 TS，干活在 Python worker） ----
// 默认开着 —— 这是迁移的目标状态。设 PICTORIA_SCHEDULER=0 可以整个停掉，用来二分定位。
if (process.env.PICTORIA_SCHEDULER !== '0') {
  void (async () => {
    const tasks = await getTasks()
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
    // ⚠️ 这个 catch 不能省。上面整段是 fire-and-forget，而 `getTasks()` 会 reject
    // （cairnq 协议版本和 worker 建的 tasks.sqlite 对不上、文件被锁）—— Node 默认
    // `--unhandled-rejections=throw`，于是一个**已经绑好端口、70 个端点都能正常服务**
    // 的进程会被一个后台初始化失败直接干掉。退役掉的 app.py 每条后台循环都包了
    // try/except，就是这个原因。
    console.error(`[pictoria-api] 后台调度启动失败，HTTP 服务继续：${String(err)}`)
  })
}
