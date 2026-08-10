import process from 'node:process'
import { serve } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { rebuildGroups } from './dedup.js'
import { getDb } from './db.js'
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
 * 70 个端点全部在这里；反向代理已经删掉 —— 迁移期它把没搬完的路由透传给 4779 的
 * Litestar，现在没有"没搬完的"了（见 docs/refactor-monorepo-hono.md §Phase 6）。
 *
 * Litestar 的代码还在 `server/src/server/`，但只作为对拍脚本的**参照实现**存在：
 * `just server-ref` 手动起它，`pnpm parity:all` 拿它当基准。它不再服务任何流量。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)
/**
 * 只有 `/schema/openapi.json` 还会问它一句，而且问不到也无所谓 —— 见下面。
 * 对拍脚本自己直接打 4779，不经过这里。
 */
const UPSTREAM = process.env.PICTORIA_UPSTREAM ?? 'http://127.0.0.1:4779'

const app = new OpenAPIHono()

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
 * 迁移期它必须把两侧合起来（只给 Hono 已实现的那几个会让客户端缺掉大半 API）。
 * 现在 70 个端点都在本地，上游那一份只剩一个用处：Litestar 跑着的时候，
 * `contract:diff` 能顺带看出本地有没有漏掉哪个组件 schema。上游不在就直接给本地
 * 这一份，而那才是最终形态。
 */
app.get('/schema/openapi.json', async (c) => {
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

  let upstream: any
  try {
    upstream = await (await fetch(`${UPSTREAM}/schema/openapi.json`)).json()
  }
  catch {
    // 上游没起来时，至少把本地这份给出去，而不是 502 —— genapi 至少还能跑。
    return c.json(local)
  }

  // 必须**按方法**合并，不能按路径。一个路径下的 GET 搬过来了、POST 还在上游是
  // 常态（/v2/tags 就是），路径级的浅合并会把上游那一整个 path item 挤掉，于是
  // POST/DELETE 从文档里凭空消失 —— contract-diff 会报，但别等它报。
  const paths: Record<string, any> = { ...upstream.paths }
  for (const [route, item] of Object.entries(local.paths ?? {}))
    paths[route] = { ...paths[route], ...(item as object) }

  const merged = {
    ...upstream,
    paths,
    components: {
      ...upstream.components,
      schemas: { ...upstream.components?.schemas, ...local.components?.schemas },
    },
  }
  return c.json(merged)
})

/**
 * 没有路由匹配时的 404。
 *
 * Hono 默认回一句纯文本 `404 Not Found`，Litestar 回的是
 * `{"status_code":404,"detail":"Not Found"}`。代理还在的时候这个差别被藏住了
 * （未匹配的一律透传），删掉代理才露出来。前端的错误处理认 JSON 那一种。
 */
app.notFound(c => c.json({ status_code: 404, detail: 'Not Found' }, 404))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.warn(`[pictoria-api] listening on http://127.0.0.1:${info.port}`)
})

// ---- backfill 调度（§D2：挑活在 TS，干活在 Python worker） ----
// 默认开着 —— 这是迁移的目标状态。Python 侧对应地用 PICTORIA_SKIP_WORKERS 把同名
// worker 关掉，两边不会重复算。设 PICTORIA_SCHEDULER=0 可以整个停掉，用来二分定位。
if (process.env.PICTORIA_SCHEDULER !== '0') {
  void (async () => {
    const tasks = await getTasks()
    const { sqlite } = getDb()
    // basics 排在最前：其余 worker 的输入（尺寸、缩略图）都由它产出。
    startBasicsBackfill(sqlite, tasks)
    for (const scorer of ['silva', 'silva_luna'] as const)
      startSilvaBackfill(sqlite, tasks, { scorer })
    startWaifuBackfill(sqlite, tasks)
    startTaggerBackfill(sqlite, tasks)
    // embedding 的待办清空之后要重建近重复分组 —— 新图不经过这一步就永远不会被
    // 认成任何一张老图的重复（对应 Python 侧 EMBEDDING_WORKER 的 on_backfill_complete）。
    startEmbeddingBackfill(sqlite, tasks, {
      onDrained: async () => {
        await rebuildGroups(sqlite, tasks).catch((err: unknown) =>
          console.warn(`[dedup] 重建失败：${String(err)}`))
      },
    })
    // 磁盘变化和定时轮询都会触发一次对账，然后把 backfill 循环叫醒 ——
    // 对应 Python 侧 app.py 里的 watchdog + 10 分钟 poller。
    startAutoSync(sqlite, () => wakeAllBackfills())
    console.warn('[pictoria-api] backfill 调度已启动：basics, silva, silva_luna, waifu, tagger, embedding')
    console.warn('[pictoria-api] 文件监视 + 10 分钟轮询已启动')
  })()
}
