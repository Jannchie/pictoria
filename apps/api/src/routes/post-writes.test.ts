/**
 * posts 的写：单字段更新、批量更新、删除（含盘上文件的清理）。
 *
 * 打整条 `createApp` 栈（内存库 + 临时图库，见 `testing/app.ts`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { thumbnailPathFor } from '../paths.js'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

function row(id: number): { score: number, rating: number, caption: string } | undefined {
  return t.sqlite.prepare<[number], { score: number, rating: number, caption: string }>(
    'SELECT score, rating, caption FROM posts WHERE id = ?',
  ).get(id)
}

describe('PUT /v2/posts/{post_id}/score', () => {
  it('更新后回读完整的 PostDetailPublic', async () => {
    const id = t.insertPost('art', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/posts/${id}/score`, { method: 'PUT', body: { score: 4 } })
    expect(status).toBe(200)
    expect(body).toMatchObject({ id, filePath: 'art', fileName: 'a', extension: 'png', score: 4, tags: [], colors: [] })
    expect(typeof body.createdAt).toBe('string')
    expect(row(id)?.score).toBe(4)
  })

  it('post 不存在 → 404 PostNotFoundError', async () => {
    const { status, body } = await requestJson(t.app, '/v2/posts/999/score', { method: 'PUT', body: { score: 1 } })
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'PostNotFoundError', detail: 'Post with id 999 not found.' })
  })

  it('越界 → 400 ValidationError，issue 指到 score，库不变', async () => {
    const id = t.insertPost('art', 'a', 'png', { score: 2 })
    const { status, body } = await requestJson(t.app, `/v2/posts/${id}/score`, { method: 'PUT', body: { score: 9 } })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(['score'])
    expect(row(id)?.score).toBe(2)
  })
})

describe('PUT /v2/posts/{post_id}/caption（值在 query 上）', () => {
  it('写进 caption 并回读', async () => {
    const id = t.insertPost('.', 'c', 'jpg')
    const { status, body } = await requestJson(t.app, `/v2/posts/${id}/caption?caption=${encodeURIComponent('一只猫')}`, { method: 'PUT' })
    expect(status).toBe(200)
    expect(body.caption).toBe('一只猫')
    expect(row(id)?.caption).toBe('一只猫')
  })
})

describe('PUT /v2/posts/bulk/rating', () => {
  it('204，只改列出的 id（bulk 不会被 {post_id} 路由截走）', async () => {
    const a = t.insertPost('.', 'a', 'png')
    const b = t.insertPost('.', 'b', 'png')
    const c = t.insertPost('.', 'c', 'png')
    const res = await t.app.request(`/v2/posts/bulk/rating?ids=${a}&ids=${b}&rating=3`, { method: 'PUT' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect([row(a)?.rating, row(b)?.rating, row(c)?.rating]).toEqual([3, 3, 0])
  })

  it('rating 越界 → 400 ValidationError', async () => {
    const a = t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/posts/bulk/rating?ids=${a}&rating=9`, { method: 'PUT' })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(row(a)?.rating).toBe(0)
  })
})

describe('DELETE /v2/posts/delete', () => {
  it('删行、删原图、删缩略图；没列出的 post 原样保留', async () => {
    const gone = t.insertPost('art', 'gone', 'png', { file: true, thumbnail: true })
    const kept = t.insertPost('art', 'kept', 'png', { file: true, thumbnail: true })
    const original = path.join(t.root, 'art', 'gone.png')
    const thumb = thumbnailPathFor('art/gone.png')
    expect(fs.existsSync(original) && fs.existsSync(thumb)).toBe(true)

    const res = await t.app.request(`/v2/posts/delete?ids=${gone}`, { method: 'DELETE' })
    expect(res.status).toBe(204)

    expect(row(gone)).toBeUndefined()
    expect(fs.existsSync(original)).toBe(false)
    expect(fs.existsSync(thumb)).toBe(false)
    expect(row(kept)).toBeDefined()
    expect(fs.existsSync(path.join(t.root, 'art', 'kept.png'))).toBe(true)
  })

  it('文件早已不在盘上也照样删行（unlink 尽力而为）', async () => {
    const id = t.insertPost('art', 'ghost', 'png')
    const res = await t.app.request(`/v2/posts/delete?ids=${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(row(id)).toBeUndefined()
  })

  it('缺 ids → 400 ValidationError', async () => {
    const { status, body } = await requestJson(t.app, '/v2/posts/delete', { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
  })
})
