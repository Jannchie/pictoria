/**
 * `/v2/folders`：目录树（文件数、post 数、跳过 `.pictoria`）与删目录的三种结局。
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

interface Dir { name: string, path: string, fileCount: number, postCount: number, scoreAvg: number | null, children: Dir[] }

describe('GET /v2/folders', () => {
  it('递归计数，跳过 .pictoria，post 数和分数均值逐层汇总', async () => {
    t.insertPost('.', 'root', 'png', { file: true, thumbnail: true, score: 2 })
    t.insertPost('art', 'a', 'png', { file: true, score: 4 })
    t.insertPost('art/sub', 'b', 'png', { file: true })
    t.writeFile('art/notes.txt')

    const { status, body } = await requestJson<Dir>(t.app, '/v2/folders')
    expect(status).toBe(200)
    expect(body).toMatchObject({ name: '', path: '.', fileCount: 4, postCount: 3 })
    expect(body.children.map(c => c.name)).toEqual(['art']) // 没有 .pictoria
    const art = body.children[0]!
    expect(art).toMatchObject({ name: 'art', path: 'art', fileCount: 3, postCount: 2 })
    expect(art.children).toHaveLength(1)
    expect(art.children[0]).toMatchObject({ name: 'sub', path: 'art/sub', fileCount: 1, postCount: 1, children: [] })
    expect(body).toHaveProperty('silvaAvg')
  })
})

describe('DELETE /v2/folders/{folder_path}', () => {
  it('删掉目录下的 post 行、原图、缩略图和整棵目录树', async () => {
    const inside = t.insertPost('art/sub', 'x', 'png', { file: true, thumbnail: true })
    const outside = t.insertPost('keep', 'y', 'png', { file: true })
    t.writeFile('art/sub/readme.txt')

    const { status, body } = await requestJson(t.app, '/v2/folders/art/sub', { method: 'DELETE' })
    expect(status).toBe(200)
    expect(body).toEqual({ msg: 'Deleted folder art/sub (1 posts)' })

    const ids = t.sqlite.prepare<[], number>('SELECT id FROM posts ORDER BY id').pluck().all()
    expect(ids).toEqual([outside])
    expect(ids).not.toContain(inside)
    expect(fs.existsSync(path.join(t.root, 'art', 'sub'))).toBe(false)
    expect(fs.existsSync(path.dirname(thumbnailPathFor('art/sub/x.png')))).toBe(false)
    expect(fs.existsSync(path.join(t.root, 'art'))).toBe(true)
    expect(fs.existsSync(path.join(t.root, 'keep', 'y.png'))).toBe(true)
  })

  it('目录不存在 → 404 DirectoryNotFoundError', async () => {
    const { status, body } = await requestJson(t.app, '/v2/folders/nope', { method: 'DELETE' })
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'DirectoryNotFoundError', detail: 'Directory not found: nope' })
  })

  it('是文件不是目录 → 400 PathNotADirectoryError', async () => {
    t.writeFile('file.txt')
    const { status, body } = await requestJson(t.app, '/v2/folders/file.txt', { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body.error).toBe('PathNotADirectoryError')
    expect(fs.existsSync(path.join(t.root, 'file.txt'))).toBe(true)
  })

  it.each(['@', '.pictoria', '.pictoria/thumbnails'])('拒绝删库根 / .pictoria：%s → 400', async (folder) => {
    t.insertPost('.', 'root', 'png', { file: true, thumbnail: true })
    const { status, body } = await requestJson(t.app, `/v2/folders/${folder}`, { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body.error).toBe('PathNotADirectoryError')
    expect(fs.existsSync(path.join(t.root, '.pictoria'))).toBe(true)
    expect(t.sqlite.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(1)
  })
})
