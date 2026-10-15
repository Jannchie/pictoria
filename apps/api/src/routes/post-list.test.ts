/**
 * posts 的列表：游标分页（`GET /v2/posts`）与过滤搜索（`POST /v2/posts/search`）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, fakeTasks, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

describe('GET /v2/posts', () => {
  it('按 id 升序分页，nextCursor 是下一页第一条的 id，末页为 null', async () => {
    const ids = [1, 2, 3].map(i => t.insertPost('.', `p${i}`, 'png'))

    const first = await requestJson(t.app, '/v2/posts?limit=2')
    expect(first.status).toBe(200)
    expect(first.body.items.map((p: { id: number }) => p.id)).toEqual(ids.slice(0, 2))
    expect(first.body.nextCursor).toBe(ids[2])
    expect(first.body.items[0]).toMatchObject({ fileName: 'p1', tags: [], colors: [], groupMemberCount: expect.any(Number) })

    const second = await requestJson(t.app, `/v2/posts?limit=2&start=${first.body.nextCursor}`)
    expect(second.body.items.map((p: { id: number }) => p.id)).toEqual([ids[2]])
    expect(second.body.nextCursor).toBeNull()
  })

  it('近重复组的成员不出现在列表里', async () => {
    const head = t.insertPost('.', 'head', 'png')
    const member = t.insertPost('.', 'member', 'png')
    t.sqlite.prepare('UPDATE posts SET canonical_post_id = ? WHERE id = ?').run(head, member)
    const { body } = await requestJson(t.app, '/v2/posts')
    expect(body.items.map((p: { id: number }) => p.id)).toEqual([head])
  })

  it('limit=0 → 400 ValidationError', async () => {
    const { status, body } = await requestJson(t.app, '/v2/posts?limit=0')
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(['limit'])
  })
})

describe('POST /v2/posts/search', () => {
  it('按 rating 过滤，回 PostSimplePublic 数组', async () => {
    t.insertPost('.', 'safe', 'png', { rating: 1 })
    const r3a = t.insertPost('.', 'r3a', 'png', { rating: 3 })
    const r3b = t.insertPost('art', 'r3b', 'jpg', { rating: 3 })

    const { status, body } = await requestJson(t.app, '/v2/posts/search', { method: 'POST', body: { rating: [3] } })
    expect(status).toBe(200)
    expect(body.map((p: { id: number }) => p.id).sort()).toEqual([r3a, r3b].sort())
    expect(body[0]).toMatchObject({ rating: 3, filePath: expect.any(String), fileName: expect.any(String) })
    expect(body[0]).not.toHaveProperty('tags') // 简版，不带标签
  })

  it('offset / limit 作用在过滤结果上', async () => {
    for (let i = 0; i < 5; i++) t.insertPost('.', `p${i}`, 'png', { rating: 2 })
    const { body } = await requestJson(t.app, '/v2/posts/search?limit=2&offset=4', { method: 'POST', body: { rating: [2] } })
    expect(body).toHaveLength(1)
  })

  it('非法的排序列 → 400 ValidationError', async () => {
    const { status, body } = await requestJson(t.app, '/v2/posts/search', { method: 'POST', body: { orderBy: 'no_such_column' } })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
  })
})

describe('POST /v2/posts/search/text', () => {
  it('空查询直接回 []，不提交文本编码任务', async () => {
    const tasks = fakeTasks()
    t.close()
    t = createTestApp({ tasks })
    const { status, body } = await requestJson(t.app, '/v2/posts/search/text', { method: 'POST', body: { query: '   ' } })
    expect(status).toBe(200)
    expect(body).toEqual([])
    expect(tasks.calls).toEqual([])
  })
})
