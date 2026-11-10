/**
 * 浏览器来源的闸门（`security.ts`）：CORS 白名单、Host 校验、写请求的 Origin 校验。
 *
 * multipart 的 POST 是"简单请求"，浏览器不发预检 —— 那条用例才是 CSRF 的真实形状。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { hostHeaderName, originPolicyFromEnv } from './security.js'
import { createTestApp, type TestApp } from './testing/app.js'

let t: TestApp | undefined

afterEach(() => {
  t?.close()
  t = undefined
})

function app() {
  t = createTestApp()
  return t.app
}

const GOOD = 'http://localhost:4778'
const EVIL = 'https://evil.example'

describe('originPolicyFromEnv', () => {
  it('默认只有前端的两个源；环境变量追加源与主机名', () => {
    expect(originPolicyFromEnv({}).origins).toEqual(['http://localhost:4778', 'http://127.0.0.1:4778'])
    const p = originPolicyFromEnv({ PICTORIA_ALLOWED_ORIGINS: 'http://192.168.1.5:4778/, http://NAS.local:8080', PICTORIA_ALLOWED_HOSTS: 'pictoria.lan' })
    expect(p.origins).toContain('http://192.168.1.5:4778')
    expect(p.origins).toContain('http://nas.local:8080')
    expect(p.hosts).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '[::1]', '192.168.1.5', 'nas.local', 'pictoria.lan']))
  })

  it('hostHeaderName 去端口', () => {
    expect(hostHeaderName('localhost:4777')).toBe('localhost')
    expect(hostHeaderName('[::1]:4777')).toBe('[::1]')
    expect(hostHeaderName('127.0.0.1')).toBe('127.0.0.1')
    expect(hostHeaderName('Evil.Example:80')).toBe('evil.example')
  })
})

describe('CORS', () => {
  it('白名单源的预检通过并回显该源', async () => {
    const res = await app().request('/v2/posts/upload', {
      method: 'OPTIONS',
      headers: { 'origin': GOOD, 'access-control-request-method': 'POST', 'host': 'localhost:4777' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(GOOD)
  })

  it('白名单源的 GET 带 ACAO', async () => {
    const res = await app().request('/v2/cmd/import-from-url/status', { headers: { origin: 'http://127.0.0.1:4778', host: '127.0.0.1:4777' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4778')
  })

  it('陌生源的预检 → 403，不带 ACAO', async () => {
    const res = await app().request('/v2/posts/upload', {
      method: 'OPTIONS',
      headers: { 'origin': EVIL, 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('陌生源的 GET 照常回（浏览器读不到：没有 ACAO）', async () => {
    const res = await app().request('/v2/cmd/import-from-url/status', { headers: { origin: EVIL } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('写请求的 Origin', () => {
  function multipartUpload(headers: Record<string, string>) {
    const body = new FormData()
    body.append('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    return app().request('/v2/posts/upload', { method: 'POST', body, headers })
  }

  it('陌生源的 multipart POST（简单请求，无预检）→ 403，不落文件', async () => {
    const res = await multipartUpload({ origin: EVIL })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'ForbiddenOrigin' })
    expect(t!.sqlite.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0)
  })

  it('`Origin: null`（沙箱 iframe / file://）→ 403', async () => {
    expect((await multipartUpload({ origin: 'null' })).status).toBe(403)
  })

  it('白名单源的 multipart POST 放行', async () => {
    const res = await multipartUpload({ origin: GOOD, host: 'localhost:4777' })
    expect(res.status).toBe(201)
  })

  it('不带 Origin 的写请求（curl / 脚本）放行', async () => {
    const res = await multipartUpload({})
    expect(res.status).toBe(201)
  })

  it('DELETE / PUT 同样受检', async () => {
    const a = app()
    expect((await a.request('/v2/folders/x', { method: 'DELETE', headers: { origin: EVIL } })).status).toBe(403)
    expect((await a.request('/v2/posts/1/score', { method: 'PUT', headers: { origin: EVIL } })).status).toBe(403)
  })
})

describe('Host（DNS rebinding）', () => {
  it.each(['localhost:4777', '127.0.0.1:4777', '[::1]:4777', 'localhost'])('本机名字 %s 放行', async (host) => {
    const res = await app().request('/v2/cmd/import-from-url/status', { headers: { host } })
    expect(res.status).toBe(200)
  })

  it.each(['evil.example:4777', 'evil.example', '192.168.1.5:4777', 'localhost.evil.example'])('陌生 Host %s → 403（读请求也拒）', async (host) => {
    const res = await app().request('/v2/cmd/import-from-url/status', { headers: { host } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'ForbiddenHost' })
  })

  it('rebinding 的形状：同源（不带 Origin）的写请求，Host 是攻击者域名 → 403', async () => {
    const body = new FormData()
    body.append('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    const res = await app().request('/v2/posts/upload', { method: 'POST', body, headers: { host: 'rebind.evil.example:4777' } })
    expect(res.status).toBe(403)
  })
})
