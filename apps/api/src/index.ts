import process from 'node:process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { createProxy } from './proxy.js'

/**
 * Pictoria API —— 迁移期的门面。
 *
 * 现在它 100% 是个反向代理：占住前端硬编码的 4777，把一切转给挪到 4779 的
 * Litestar。端点会一组一组从下面搬上来（见 docs/refactor-monorepo-hono.md
 * §5 Phase 4），每搬完一组就少一条透传规则，直到代理整个删掉。
 */

const PORT = Number(process.env.PICTORIA_API_PORT ?? 4777)
const UPSTREAM = process.env.PICTORIA_UPSTREAM ?? 'http://127.0.0.1:4779'

const app = new Hono()

// 代理向上游摘掉了 accept-encoding（见 proxy.ts 的 RECOMPUTED 注释），所以
// 压缩由这里补回来，保持和直连 Litestar 一样的传输体积。Hono 的实现按
// content-type 白名单过滤，不会去压已经压过的 JPEG/PNG，也会跳过 206。
app.use('*', compress())

// ---- 已迁移到 Hono 的路由写在这里 ----
// （Phase 4 开始逐组填充；每加一组，就从下面的透传里少一组）

// ---- 其余一律透传给 Litestar ----
// 放在最后：Hono 按注册顺序匹配，上面任何一条命中就不会走到这里。
app.all('*', createProxy({ upstream: UPSTREAM }))

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.warn(`[pictoria-api] listening on http://127.0.0.1:${info.port}`)
  console.warn(`[pictoria-api] proxying unmigrated routes to ${UPSTREAM}`)
})
