/**
 * `/v2/grading`：一副牌、带情境的写分、一致度。打整条 `createApp` 栈。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

describe('GET /v2/grading/deck', () => {
  it('回一副带图片信息的牌：新图 previous = 0，重打带旧分', async () => {
    const fresh = t.insertPost('art', 'a', 'png')
    const graded = t.insertPost('art', 'b', 'png', { score: 4 })

    const { status, body } = await requestJson(t.app, '/v2/grading/deck?limit=10')

    expect(status).toBe(200)
    const byId = new Map(body.map((c: { post: { id: number } }) => [c.post.id, c]))
    expect(byId.get(fresh)).toMatchObject({ post: { filePath: 'art', fileName: 'a', extension: 'png' }, reason: 'new', previous: 0, model: null })
    expect(byId.get(graded)).toMatchObject({ reason: 'random', previous: 4 })
  })

  it('limit 越界 → 400', async () => {
    const { status } = await requestJson(t.app, '/v2/grading/deck?limit=0')
    expect(status).toBe(400)
  })
})

describe('GET /v2/grading/anchors', () => {
  it('五档从高到低各一行，没有合格的图时该行为空', async () => {
    const { status, body } = await requestJson(t.app, '/v2/grading/anchors')

    expect(status).toBe(200)
    expect(body).toEqual([5, 4, 3, 2, 1].map(grade => ({ grade, posts: [] })))
  })

  it('回的是带图片信息的参照图', async () => {
    const id = t.insertPost('art', 'a', 'png', { score: 4 })
    t.sqlite.prepare('UPDATE posts SET rating = 1 WHERE id = ?').run(id)
    t.sqlite.prepare("INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', 0.75)").run(id)

    const { body } = await requestJson(t.app, '/v2/grading/anchors')

    expect(body.find((r: { grade: number }) => r.grade === 4).posts).toMatchObject([{ id, filePath: 'art', fileName: 'a' }])
  })
})

describe('打分情境与一致度', () => {
  it('带 source 的写分进事件流，并算进 /v2/grading/stats', async () => {
    const id = t.insertPost('art', 'a', 'png', { score: 3 })

    const put = await requestJson(t.app, `/v2/posts/${id}/score`, { method: 'PUT', body: { score: 3, source: 'grade:random' } })
    expect(put.status).toBe(200)

    expect(t.sqlite.prepare('SELECT post_id, score, previous, source FROM post_score_events').all())
      .toEqual([{ post_id: id, score: 3, previous: 3, source: 'grade:random' }])
    const { body } = await requestJson(t.app, '/v2/grading/stats')
    expect(body).toEqual({
      gradedToday: 1,
      self: { n: 1, exact: 1, far: 0 },
      model: { n: 0, exact: null, far: null },
    })
  })

  it('不认识的 source → 400，不写分', async () => {
    const id = t.insertPost('art', 'a', 'png', { score: 2 })

    const { status } = await requestJson(t.app, `/v2/posts/${id}/score`, { method: 'PUT', body: { score: 5, source: 'whatever' } })

    expect(status).toBe(400)
    expect(t.sqlite.prepare('SELECT score FROM posts WHERE id = ?').pluck().get(id)).toBe(2)
  })
})
