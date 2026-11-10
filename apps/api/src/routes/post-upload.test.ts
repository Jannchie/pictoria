/**
 * `POST /v2/posts/upload` 的 URL 分支：上游失败不落文件不建行，同一路径的并发上传回 409。
 *
 * 远程下载走全局 `fetch`，这里换成假的；`app.request` 本身不经过它。
 */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => {
  vi.restoreAllMocks()
  t.close()
})

function upload(form: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(form)) body.append(k, v)
  return t.app.request('/v2/posts/upload', { method: 'POST', body })
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) => impl(String(url), init)) as typeof fetch)
}

const rows = () => t.sqlite.prepare('SELECT COUNT(*) FROM posts').pluck().get() as number

describe('POST /v2/posts/upload（url）', () => {
  it('2xx 且 image/* → 201，文件和行都在', async () => {
    mockFetch(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    const res = await upload({ url: 'https://example.com/a.png', path: 'up/a.png' })
    expect(res.status).toBe(201)
    expect(fs.readFileSync(path.join(t.root, 'up', 'a.png'))).toEqual(Buffer.from([1, 2, 3]))
    expect(rows()).toBe(1)
  })

  it('上游 404 → 422 UpstreamFetchError，不落文件不建行', async () => {
    mockFetch(async () => new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }))
    const res = await upload({ url: 'https://example.com/a.png', path: 'up/a.png' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toBe('UpstreamFetchError')
    expect(fs.existsSync(path.join(t.root, 'up'))).toBe(false)
    expect(rows()).toBe(0)
  })

  it('200 但不是图片（挑战页、防盗链 HTML）→ 422', async () => {
    mockFetch(async () => new Response('<html>hi</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    const res = await upload({ url: 'https://example.com/a.png' })
    expect(res.status).toBe(422)
    expect(rows()).toBe(0)
  })

  it('请求带超时信号；超时 → 422', async () => {
    const seen: Array<AbortSignal | null | undefined> = []
    mockFetch(async (_url, init) => {
      seen.push(init?.signal)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const res = await upload({ url: 'https://example.com/a.png' })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { detail: string }).detail).toMatch(/timed out/)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(rows()).toBe(0)
  })

  it('下载期间同一路径被别的上传建了行 → 409，不覆盖文件', async () => {
    mockFetch(async () => {
      // 模拟并发：existsSync 已经过了，另一个请求在我们下载时先建了行
      t.insertPost('up', 'a', 'png')
      return new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } })
    })
    const res = await upload({ url: 'https://example.com/a.png', path: 'up/a.png' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('FileAlreadyExistsError')
    expect(fs.existsSync(path.join(t.root, 'up', 'a.png'))).toBe(false)
    expect(rows()).toBe(1)
  })
})

describe('POST /v2/posts/upload（文件）：目标与文件名', () => {
  function uploadFile(name: string, extra: Record<string, string> = {}) {
    const body = new FormData()
    body.append('file', new File([new Uint8Array([7])], name, { type: 'image/png' }))
    for (const [k, v] of Object.entries(extra)) body.append(k, v)
    return t.app.request('/v2/posts/upload', { method: 'POST', body })
  }

  it.each([
    ['.pictoria', 'gallery-dl.conf'],
    ['.pictoria', 'x.png'],
    ['.PICTORIA', 'x.png'],
    ['.pictoria.', 'x.png'],
    ['.pictoria/thumbnails', 'x.png'],
    ['art/../.pictoria', 'x.png'],
    ['..', 'x.png'],
    ['C:/Windows', 'x.png'],
  ])('path=%s file=%s → 400，不落文件不建行', async (dir, name) => {
    const res = await uploadFile(name, { path: dir })
    expect(res.status).toBe(400)
    expect(rows()).toBe(0)
    expect(fs.existsSync(path.join(t.root, '.pictoria', name))).toBe(false)
  })

  it.each(['a.txt', 'gallery-dl.conf', 'evil.svg', 'noext', 'a.png.exe'])('非图片扩展名 %s → 400', async (name) => {
    const res = await uploadFile(name)
    expect(res.status).toBe(400)
    expect(rows()).toBe(0)
  })

  it('文件名里的目录段被剥掉：只能经 path 字段指定目录', async () => {
    const res = await uploadFile('../../.pictoria/x.png', { path: 'up' })
    expect(res.status).toBe(201)
    expect(fs.existsSync(path.join(t.root, 'up', 'x.png'))).toBe(true)
  })

  it('文件名里的 ADS 冒号和保留字符被替换，末尾点号被剥掉', async () => {
    const res = await uploadFile('a:b<c>.png..')
    expect(res.status).toBe(201)
    expect(fs.existsSync(path.join(t.root, 'a_b_c_.png'))).toBe(true)
  })

  it('url 上传的文件名取 URL 路径最后一段，不带 query', async () => {
    mockFetch(async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }))
    const res = await upload({ url: 'https://example.com/dir/b.png?sig=../../x' })
    expect(res.status).toBe(201)
    expect(fs.existsSync(path.join(t.root, 'b.png'))).toBe(true)
  })
})
