import type { Context } from 'hono'

/**
 * 迁移期间的透传代理：Hono 没实现的路由原样转给 Litestar。
 *
 * 这是 strangler 的支点 —— 70 个端点可以一个一个搬，任何一个搬砸了都能把
 * 路由删掉、让流量重新落回这里。等 Phase 4 结束、代理规则清空，整个文件删掉。
 */

/**
 * 逐跳首部（RFC 9110 §7.6.1）。它们描述的是单条 TCP 连接本身，不是被传输的
 * 消息，转发出去会让下游对连接状态产生错误认知。
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 上游返回后必须重算、不能照抄的首部。
 *
 * `content-length`：Node 的 fetch(undici) 会**自动解压** gzip 响应体，但把
 * `content-encoding` 原样留在 headers 里。照抄这两个首部会让浏览器拿着已经
 * 解压的数据再解一次 —— 直接是乱码。我们在请求侧就摘掉 `accept-encoding`
 * 让上游返回 identity，这里再兜一道底。
 */
const RECOMPUTED = new Set(['content-encoding', 'content-length'])

function forwardRequestHeaders(src: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of src) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    // 让上游别压缩：见 RECOMPUTED 的注释。代价是一次本机回环上的明文传输，
    // 换来的是不必在代理里做 gunzip→gzip 的往返。
    if (key === 'accept-encoding') continue
    // Host 必须重写成上游的，否则 Litestar 看到的是代理的 host。
    if (key === 'host') continue
    out.set(k, v)
  }
  return out
}

function forwardResponseHeaders(src: Headers): Headers {
  const out = new Headers()
  for (const [k, v] of src) {
    const key = k.toLowerCase()
    if (HOP_BY_HOP.has(key) || RECOMPUTED.has(key)) continue
    out.set(k, v)
  }
  return out
}

export interface ProxyOptions {
  /** 上游 Litestar 的 origin，例如 http://127.0.0.1:4779 */
  upstream: string
}

export function createProxy({ upstream }: ProxyOptions) {
  return async (c: Context): Promise<Response> => {
    const incoming = new URL(c.req.url)
    const target = new URL(incoming.pathname + incoming.search, upstream)

    const method = c.req.method
    // GET/HEAD 没有 body；其余把可读流原样往上游送。`duplex: 'half'` 是
    // undici 对流式请求体的硬性要求，缺了会直接抛 TypeError。
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const body = hasBody ? c.req.raw.body : undefined

    let upstreamResponse: Response
    try {
      upstreamResponse = await fetch(target, {
        method,
        headers: forwardRequestHeaders(c.req.raw.headers),
        body,
        ...(body ? { duplex: 'half' } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(10 * 60 * 1000),
      } as RequestInit)
    }
    catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return c.json(
        { status_code: 502, detail: `upstream unreachable: ${detail}`, extra: { upstream, path: incoming.pathname } },
        502,
      )
    }

    // 直接把上游的可读流交出去 —— 不缓冲。原图动辄几十 MB，缓冲会让内存
    // 随并发线性上涨，也会让首字节时间变差。
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: forwardResponseHeaders(upstreamResponse.headers),
    })
  }
}
