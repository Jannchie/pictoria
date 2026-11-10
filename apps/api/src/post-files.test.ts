/**
 * `deletePostFiles`：分块删、块间让出事件循环、文件走异步 rm。
 *
 * 删一个几万张图的目录原来是一整段同步代码，期间 API 不响应任何请求。这里钉住：
 * 删到一半时事件循环里排着的回调能插进来（此时库里还剩没删的块），最后全部删干净。
 */
import fs from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DELETE_CHUNK } from '@pictoria/db'
import { thumbnailPathFor } from './paths.js'
import { deletePostFiles } from './post-files.js'
import { createTestApp, requestJson, type TestApp } from './testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

const postCount = () => t.sqlite.prepare('SELECT count(*) FROM posts').pluck().get() as number

it('块与块之间让出事件循环，最后行和文件全没了', async () => {
  const n = DELETE_CHUNK * 2 + 7
  const ids: number[] = []
  t.sqlite.transaction(() => {
    for (let i = 0; i < n; i++)
      ids.push(t.insertPost('big', `f${i}`, 'png'))
  })()
  const withFile = [0, DELETE_CHUNK + 1, n - 1].map(i => t.insertPost('big', `real${i}`, 'png', { file: true, thumbnail: true }))
  const files = withFile.map(id => {
    const r = t.sqlite.prepare('SELECT full_path FROM posts WHERE id = ?').pluck().get(id) as string
    return `${t.root}/${r}`
  })
  expect(files.every(f => fs.existsSync(f))).toBe(true)

  const seen: number[] = []
  const tick = setInterval(() => seen.push(postCount()), 0)
  const p = deletePostFiles(t.sqlite, [...ids, ...withFile])
  // 第一块是同步删的；之后每块之间都有让出点
  expect(postCount()).toBe(n + withFile.length - DELETE_CHUNK)
  const removed = await p
  clearInterval(tick)

  expect(removed).toHaveLength(n + withFile.length)
  expect(postCount()).toBe(0)
  expect(files.some(f => fs.existsSync(f))).toBe(false)
  // 删的过程中定时器跑到过，而且看到的是删了一部分的库
  expect(seen.some(c => c > 0 && c < n + withFile.length)).toBe(true)
})

it('unlink: false 只删行（仍然分块），盘上的原图和缩略图原样留着', async () => {
  const n = DELETE_CHUNK + 3
  const ids: number[] = []
  t.sqlite.transaction(() => {
    for (let i = 0; i < n; i++)
      ids.push(t.insertPost('big', `f${i}`, 'png'))
  })()
  const id = t.insertPost('big', 'real', 'png', { file: true, thumbnail: true })
  const rel = t.sqlite.prepare('SELECT full_path FROM posts WHERE id = ?').pluck().get(id) as string
  const file = `${t.root}/${rel}`
  const thumb = thumbnailPathFor(rel)
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.existsSync(thumb)).toBe(true)

  const p = deletePostFiles(t.sqlite, [...ids, id], { unlink: false })
  expect(postCount()).toBe(n + 1 - DELETE_CHUNK)
  const removed = await p

  expect(removed).toHaveLength(n + 1)
  expect(postCount()).toBe(0)
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.existsSync(thumb)).toBe(true)
})

it('DELETE /v2/folders 删大目录走同一条分块路径', async () => {
  t.sqlite.transaction(() => {
    for (let i = 0; i < DELETE_CHUNK + 3; i++)
      t.insertPost('art/big', `f${i}`, 'png')
  })()
  t.insertPost('art/big', 'real', 'png', { file: true })
  const keep = t.insertPost('keep', 'y', 'png', { file: true })
  const { status, body } = await requestJson(t.app, '/v2/folders/art/big', { method: 'DELETE' })
  expect(status).toBe(200)
  expect(body).toEqual({ msg: `Deleted folder art/big (${DELETE_CHUNK + 4} posts)` })
  expect(t.sqlite.prepare('SELECT id FROM posts').pluck().all()).toEqual([keep])
  expect(fs.existsSync(`${t.root}/art/big`)).toBe(false)
})
