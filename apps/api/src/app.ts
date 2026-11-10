/**
 * Pictoria API 的组装：中间件、路由挂载、`/schema/openapi.json`、404 / 500 的形状。
 *
 * 只组装，不带任何启动副作用 —— 不开库、不跑迁移、不 `serve()`、不起调度器和文件监视。
 * 那些都在 `index.ts`。分开是为了让测试能拿一个内存库和假的 tasks 造出**整条**
 * 路由栈（`testing/app.ts`），用 `app.request()` 打真实的 handler，而不是连生产库。
 *
 * 契约的守卫是 `pnpm contract:check`：从活的 API 重新生成前端客户端，和已提交的有
 * diff 就失败。从 Litestar 迁过来的记录在 `docs/refactor-monorepo-hono.md`。
 */
import type { SqliteHandle } from '@pictoria/db'
import type { AppEnv, TaskSource, UnratedArtistSnapshot } from './env.js'
import { OpenAPIHono } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { DanbooruImports } from './danbooru-imports.js'
import { type DedupRebuilder, rebuilderFor } from './dedup.js'
import { fail } from './openapi.js'
import { createAppReads, ReadCache } from './read-cache.js'
import { inProcessReads, type Reads } from './read-pool.js'
import { originGuard, originPolicyFromEnv } from './security.js'
import { annotationQueuesRoutes } from './routes/annotation-queues.js'
import { annotationsRoutes } from './routes/annotations.js'
import { commandsRoutes } from './routes/commands.js'
import { danbooruImportsRoutes } from './routes/danbooru-imports.js'
import { FolderTree, foldersRoutes } from './routes/folders.js'
import { imagesRoutes } from './routes/images.js'
import { postCountsRoutes } from './routes/post-counts.js'
import { postListRoutes } from './routes/post-list.js'
import { postReadsRoutes } from './routes/post-reads.js'
import { postWritesRoutes } from './routes/post-writes.js'
import { queuesRoutes } from './routes/queues.js'
import { statisticsRoutes } from './routes/statistics.js'
import { tagsRoutes } from './routes/tags.js'
import { tagWritesRoutes } from './routes/tag-writes.js'

export interface AppDeps {
  /** 图库连接。迁移由调用方负责（生产在 `index.ts`，测试在 `createTestDb()`）。 */
  db: SqliteHandle
  /** cairnq 句柄的来源。生产是 `tasks.ts` 的 `getTasks`/`peekTasks`。 */
  tasks: TaskSource
  /**
   * Danbooru 导入作业队列。省略时（生产）每个 app 新建一个；测试传自己建的实例，好拿着
   * 它的句柄等后台作业跑完（`idle()`）、或调小块大小和并发。
   */
  danbooruImports?: DanbooruImports
  /**
   * 重读查询（向量 KNN）。省略时在主线程上同步跑 `db` —— 测试要的就是这个；生产在
   * `index.ts` 传读线程池。
   */
  reads?: Reads
  /** 计数类读的结果缓存。省略时每个 app 新建一个（测试之间不共享）。 */
  readCache?: ReadCache
  /** 目录树状态。省略时新建一个不挂文件监视的（每次请求按 mtime 全量校验）；生产传 `{ watch: true }` 的。 */
  folderTree?: FolderTree
  /** 近重复重建器。省略时取这个库的那一个（`rebuilderFor(db)`，调度器用的也是它）。 */
  dedup?: DedupRebuilder
}

export function createApp({
  db,
  tasks,
  danbooruImports = new DanbooruImports(db, tasks),
  reads = inProcessReads(db),
  readCache = new ReadCache(db),
  folderTree = new FolderTree(),
  dedup = rebuilderFor(db),
}: AppDeps) {
  const app = new OpenAPIHono<AppEnv>()
  const appReads = createAppReads(reads, readCache)
  const unratedArtists: UnratedArtistSnapshot = { ids: null }

  /**
   * 浏览器来源的闸门（`security.ts`）：先 Host / Origin，再 CORS。
   *
   * CORS —— 前端在 4778，API 在 4777，每一个请求都是跨源的；origin 只认白名单
   * （默认 `http://localhost:4778` / `http://127.0.0.1:4778`，`PICTORIA_ALLOWED_ORIGINS` 追加）。
   * `allowHeaders` 显式列出而不是留空让 Hono 回显请求头 —— 浏览器看来等价，
   * 但显式的那份在响应里是稳定的。守卫在 `security.test.ts`。
   */
  const policy = originPolicyFromEnv()
  app.use('*', originGuard(policy))
  app.use('*', cors({
    origin: policy.origins,
    allowMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    allowHeaders: ['Accept', 'Accept-Language', 'Content-Language', 'Content-Type'],
    maxAge: 600,
  }))

  // 按 content-type 白名单压缩：不压 JPEG/PNG（已经是压缩格式，实测省 0.2% 纯烧
  // CPU），也跳过 206。
  app.use('*', compress())

  // 依赖注入：路由只认 `c.var.*`（见 `env.ts`），不碰模块级状态。读挂上这个请求的
  // abort signal：客户端断开（切走、过滤器变了）之后，排队中的读不再派发。
  app.use('*', async (c, next) => {
    c.set('db', db)
    c.set('tasks', tasks)
    c.set('danbooruImports', danbooruImports)
    c.set('reads', appReads.withSignal(c.req.raw.signal))
    c.set('folderTree', folderTree)
    c.set('dedup', dedup)
    c.set('unratedArtists', unratedArtists)
    await next()
  })

  app.route('/', statisticsRoutes)
  app.route('/', queuesRoutes)
  app.route('/', foldersRoutes)
  app.route('/', tagsRoutes)
  app.route('/', tagWritesRoutes)
  app.route('/', annotationsRoutes)
  app.route('/', annotationQueuesRoutes)
  app.route('/', commandsRoutes)
  app.route('/', danbooruImportsRoutes)
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
  app.onError((err, c) => {
    // 客户端已经走了（`c.var.reads` 的读因为 abort 被放弃）：没人收响应，也不是错误。
    if (err.name === 'AbortError' && c.req.raw.signal.aborted)
      return new Response(null, { status: 499 })
    console.error(`[pictoria-api] 未处理的异常：${err.stack ?? String(err)}`)
    return fail(500, 'InternalServerError', 'Internal Server Error')
  })

  return app
}
