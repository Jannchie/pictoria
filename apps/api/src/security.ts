/**
 * 浏览器来源的三道闸：CORS 白名单、`Host` 校验（防 DNS rebinding）、写请求的 `Origin` 校验（防 CSRF）。
 *
 * API 只绑本机（`index.ts`），但"只绑本机"挡不住浏览器：用户开着的任何网页都能让浏览器
 * 往 `http://127.0.0.1:4777` 发请求。三道各管一种：
 *
 * - **CORS** 只决定跨源脚本能不能**读**响应，不阻止请求被发出去；
 * - **Origin**：`multipart/form-data` / `text/plain` 的 POST 是"简单请求"，不走预检，
 *   CORS 白名单根本不参与 —— 上传、删除、导入照样会执行。只有服务端自己拒绝带着陌生
 *   `Origin` 的写请求才挡得住；
 * - **Host**：DNS rebinding 让攻击者的域名解析到 127.0.0.1，此时请求在浏览器看来是**同源**的
 *   （不带 `Origin` 或带攻击者自己的源），CORS 和 Origin 白名单都失效 —— 但 `Host` 头还是攻击者
 *   的域名，只认本机名字就挡住了。
 *
 * 前端是跨源直连（`apps/web/src/shared/state.ts` 的 `baseURL = http://localhost:4777`，页面在
 * `http://localhost:4778`），所以默认白名单就是那两个源。换端口 / 用局域网地址打开前端时，
 * 用 `PICTORIA_ALLOWED_ORIGINS`（逗号分隔的完整源）放行；它的主机名同时进 Host 白名单。
 */
import type { MiddlewareHandler } from 'hono'
import process from 'node:process'
import { fail } from './openapi.js'

export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:4778', 'http://127.0.0.1:4778'] as const

/** 不管端口都放行的本机名字。端口对 rebinding 无关紧要，要防的是主机名。 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export interface OriginPolicy {
  /** 完整的源（`scheme://host[:port]`），小写、无末尾斜杠。 */
  origins: string[]
  /** 主机名（不含端口），小写；IPv6 带方括号。 */
  hosts: string[]
}

function normalizeOrigin(o: string): string {
  return o.trim().replace(/\/+$/, '').toLowerCase()
}

function hostnameOf(origin: string): string | null {
  try {
    // `URL.hostname` 对 IPv6 带方括号，与 Host 头的写法一致。
    return new URL(origin).hostname.toLowerCase()
  }
  catch {
    return null
  }
}

/**
 * 从环境变量读策略：`PICTORIA_ALLOWED_ORIGINS` 追加到默认源之后；`PICTORIA_ALLOWED_HOSTS`
 * 追加主机名（反向代理等不带浏览器源的场景）。每次 `createApp` 读一次，测试可以在调用前改 env。
 */
export function originPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const split = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const origins = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...split(env.PICTORIA_ALLOWED_ORIGINS)].map(normalizeOrigin))]
  const hosts = new Set(LOOPBACK_HOSTS)
  for (const o of origins) {
    const h = hostnameOf(o)
    if (h)
      hosts.add(h)
  }
  for (const h of split(env.PICTORIA_ALLOWED_HOSTS))
    hosts.add(h.toLowerCase())
  return { origins, hosts: [...hosts] }
}

/** `Host` 头去掉端口后的主机名。`[::1]:4777` → `[::1]`，`localhost:4777` → `localhost`。 */
export function hostHeaderName(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('['))
    return h.slice(0, h.indexOf(']') + 1)
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Host + Origin 两道闸。挂在 CORS 之前：被拒的请求不该拿到任何 CORS 头。
 *
 * - `Host` 不在白名单 → 403（所有方法）。没有 `Host` 头的请求（HTTP/1.0、进程内的
 *   `app.request()`）退回 URL 的主机名判 —— 浏览器总会带 `Host`。
 * - 带 `Origin` 且不在白名单的预检（OPTIONS）和写请求 → 403。不带 `Origin` 的写请求放行：
 *   浏览器跨源发写请求一定带 `Origin`，不带的是 curl / 脚本 / genapi 这类本机工具。
 *   `Origin: null`（沙箱 iframe、`file://`）不在白名单，照拒。
 */
export function originGuard(policy: OriginPolicy): MiddlewareHandler {
  const origins = new Set(policy.origins)
  const hosts = new Set(policy.hosts)
  return async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!hosts.has(hostHeaderName(host)))
      return fail(403, 'ForbiddenHost', `Host ${JSON.stringify(host)} is not allowed.`)

    const origin = c.req.header('origin')
    // 读请求（GET / HEAD）不判：CORS 已经让陌生源读不到响应，`<img>` 跨站引用也无害。
    if (origin !== undefined && !READ_METHODS.has(c.req.method) && !origins.has(normalizeOrigin(origin)))
      return fail(403, 'ForbiddenOrigin', `Origin ${JSON.stringify(origin)} is not allowed.`)
    await next()
  }
}
