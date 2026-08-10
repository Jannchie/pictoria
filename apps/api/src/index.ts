import process from 'node:process'
import { serve } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { createProxy } from './proxy.js'
import { foldersRoutes } from './routes/folders.js'
import { statisticsRoutes } from './routes/statistics.js'
import { tagsRoutes } from './routes/tags.js'

/**
 * Pictoria API —— 迁移期的门面。
 *
 * 占住前端硬编码的 4777。已经搬过来的路由在这里注册，其余透传给挪到 4779 的
 * Litestar（见 docs/refactor-monorepo-hono.md §5 Phase 4）。每搬完一组，透传就
 * 少一组，直到代理整个删掉。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)
const UPSTREAM = process.env.PICTORIA_UPSTREAM ?? 'http://127.0.0.1:4779'

const app = new OpenAPIHono()

// 代理向上游摘掉了 accept-encoding（见 proxy.ts 的 RECOMPUTED 注释），压缩由这里
// 补回来。Hono 的实现按 content-type 白名单过滤，不压 JPEG/PNG，也跳过 206。
app.use('*', compress())

// ---- 已迁移到 Hono 的路由 ----
app.route('/', statisticsRoutes)
app.route('/', foldersRoutes)
app.route('/', tagsRoutes)

/**
 * `/schema/openapi.json` 必须把两侧合起来。
 *
 * 前端的 `pnpm genapi` 打的就是这个地址，只给 Hono 已实现的那几个会让客户端在
 * 迁移中途缺掉大半 API。做法是取上游的完整文档，再把本地已实现端点的定义盖上去 ——
 * 于是无论一个端点在哪一侧，客户端看到的形状都一样。
 */
app.get('/schema/openapi.json', async (c) => {
  const local = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Pictoria', version: '0.1.0' },
  })

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

// ---- 其余一律透传给 Litestar ----
// 放在最后：Hono 按注册顺序匹配，上面任何一条命中就不会走到这里。
app.all('*', createProxy({ upstream: UPSTREAM }))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.warn(`[pictoria-api] listening on http://127.0.0.1:${info.port}`)
  console.warn(`[pictoria-api] proxying unmigrated routes to ${UPSTREAM}`)
})
