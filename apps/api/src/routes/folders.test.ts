/**
 * `/v2/folders`：目录树（文件数、post 数、跳过 `.pictoria`）与删目录的三种结局。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { thumbnailPathFor } from '../paths.js'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'
import { FolderTree } from './folders.js'

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

describe('GET /v2/folders：缓存与 ETag', () => {
  it('没变化时回同一个 ETag，带 If-None-Match 回 304；文件和 post 变了 ETag 跟着变', async () => {
    t.insertPost('art', 'a', 'png', { file: true, score: 4 })
    const first = await t.app.request('/v2/folders')
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^".+"$/)
    const body = await first.json()

    const again = await t.app.request('/v2/folders')
    expect(again.headers.get('etag')).toBe(etag)
    expect(await again.json()).toEqual(body)
    const notModified = await t.app.request('/v2/folders', { headers: { 'if-none-match': etag } })
    expect(notModified.status).toBe(304)

    // 库里的分数变了（目录树没变）：聚合按数据版本重算，ETag 变。
    t.sqlite.prepare('UPDATE posts SET score = 2').run()
    const rescored = await t.app.request('/v2/folders', { headers: { 'if-none-match': etag } })
    expect(rescored.status).toBe(200)
    expect(rescored.headers.get('etag')).not.toBe(etag)

    // 盘上多了一个文件（mtime 校验，没有监视器）：fileCount 跟着变。
    t.writeFile('art/b.txt')
    const { body: after } = await requestJson<Dir>(t.app, '/v2/folders')
    expect(after.children[0]).toMatchObject({ name: 'art', fileCount: 2, postCount: 1 })
  })

  it('挂监视器时：只重读事件点名的目录，新目录 / 新文件照样出现', async () => {
    const tree = new FolderTree({ watch: true })
    const app = createApp({ db: t.sqlite, tasks: t.tasks, folderTree: tree })
    try {
      t.insertPost('art', 'a', 'png', { file: true })
      const get = async () => (await requestJson<Dir>(app, '/v2/folders')).body
      expect((await get()).fileCount).toBe(1)

      t.writeFile('art/deep/x/new.png')
      t.writeFile('other/y.png')
      // 等监视器把事件送到（Windows 的 ReadDirectoryChangesW 是异步的）。
      let body = await get()
      for (let i = 0; i < 50 && body.fileCount !== 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
        body = await get()
      }
      expect(body.fileCount).toBe(3)
      expect(body.children.map(c => c.name).sort()).toEqual(['art', 'other'])
      const art = body.children.find(c => c.name === 'art')!
      expect(art.children[0]).toMatchObject({ path: 'art/deep', fileCount: 1 })
    }
    finally {
      tree.close()
    }
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

  it.each(['@', '.pictoria', '.pictoria/thumbnails', '.PICTORIA', '.Pictoria/thumbnails', '.pictoria::$INDEX_ALLOCATION', 'art/../.PICTORIA'])('拒绝删库根 / .pictoria：%s → 400', async (folder) => {
    t.insertPost('.', 'root', 'png', { file: true, thumbnail: true })
    const { status, body } = await requestJson(t.app, `/v2/folders/${folder}`, { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body.error).toBe('PathNotADirectoryError')
    expect(fs.existsSync(path.join(t.root, '.pictoria'))).toBe(true)
    expect(t.sqlite.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(1)
  })
})
