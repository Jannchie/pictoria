/**
 * 标注写路径与队列端点的正确性守卫（整条 `createApp` 栈，内存库）。
 *
 * - 同一队列项提交两次 → 409，第二条判决不落库
 * - PATCH 只收 pairwise / absolute，absolute 的值不能越过这一行的 scale
 * - next-listwise 不发剩不到 3 张的组，并把它标完成
 * - DELETE 队列：项一起删、判决留着、不存在回 404
 * - limit / count 有上下界
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

const base = { dimension: 'overall', rubricVersion: 'v1', sessionId: 's' }

const count = (table: string): number =>
  t.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number

function posts(n: number): number[] {
  return Array.from({ length: n }, (_, i) => t.insertPost('art', `p${i}`, 'png'))
}

describe('提交到已完成的队列项', () => {
  it('pairwise：第二次 409 QueueItemAlreadyDoneError，只留第一条', async () => {
    const [a, b] = posts(2)
    const q = await requestJson(t.app, '/v2/annotation-queues/pairwise', {
      method: 'POST',
      body: { name: 'q', dimensions: ['overall'], pairs: [[a, b]] },
    })
    const body = { ...base, postA: a, postB: b, winner: 'a', queueId: q.body.id, queuePosition: 0 }
    expect((await requestJson(t.app, '/v2/annotations/pairwise', { method: 'POST', body })).status).toBe(201)
    const second = await requestJson(t.app, '/v2/annotations/pairwise', { method: 'POST', body: { ...body, winner: 'b' } })
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('QueueItemAlreadyDoneError')
    expect(count('pairwise_annotations')).toBe(1)
  })

  it('absolute：整批回滚', async () => {
    const [p] = posts(1)
    const q = await requestJson(t.app, '/v2/annotation-queues/absolute', {
      method: 'POST',
      body: { name: 'q', dimensions: ['overall'], scale: 5, postIds: [p] },
    })
    const body = { events: [{ ...base, postId: p, scale: 5, value: 3 }], queueId: q.body.id, queuePosition: 0 }
    expect((await requestJson(t.app, '/v2/annotations/absolute', { method: 'POST', body })).status).toBe(201)
    expect((await requestJson(t.app, '/v2/annotations/absolute', { method: 'POST', body })).status).toBe(409)
    expect(count('absolute_annotations')).toBe(1)
  })
})

describe('PATCH /v2/annotations/{kind}/{annotation_id}', () => {
  it('listwise 不在可编辑种类里 → 400，ranking 不被写坏', async () => {
    const ids = posts(3)
    const sub = await requestJson(t.app, '/v2/annotations/listwise', {
      method: 'POST',
      body: { ...base, postIds: ids, ranking: ids },
    })
    const id = sub.body.ids[0]
    const { status } = await requestJson(t.app, `/v2/annotations/listwise/${id}`, { method: 'PATCH', body: { verdict: 'oops' } })
    expect(status).toBe(400)
    expect(t.sqlite.prepare('SELECT ranking FROM listwise_annotations WHERE id = ?').pluck().get(id)).toBe(JSON.stringify(ids))
    // timeline 仍然读得动
    expect((await requestJson(t.app, '/v2/annotations/timeline')).status).toBe(200)
  })

  it('absolute：值越过这一行的 scale → 400，范围内 → updated 1', async () => {
    const [p] = posts(1)
    const sub = await requestJson(t.app, '/v2/annotations/absolute', {
      method: 'POST',
      body: { events: [{ ...base, postId: p, scale: 3, value: 2 }] },
    })
    const id = sub.body.ids[0]
    const over = await requestJson(t.app, `/v2/annotations/absolute/${id}`, { method: 'PATCH', body: { verdict: 4 } })
    expect(over.status).toBe(400)
    expect(over.body.error).toBe('ValidationError')
    const ok = await requestJson(t.app, `/v2/annotations/absolute/${id}`, { method: 'PATCH', body: { verdict: 3 } })
    expect(ok).toEqual({ status: 200, body: { updated: 1 } })
    const missing = await requestJson(t.app, '/v2/annotations/absolute/9999', { method: 'PATCH', body: { verdict: 3 } })
    expect(missing).toEqual({ status: 200, body: { updated: 0 } })
  })

  it('pairwise：非法 winner → 400', async () => {
    const [a, b] = posts(2)
    const sub = await requestJson(t.app, '/v2/annotations/pairwise', { method: 'POST', body: { ...base, postA: a, postB: b, winner: 'a' } })
    const { status } = await requestJson(t.app, `/v2/annotations/pairwise/${sub.body.ids[0]}`, { method: 'PATCH', body: { verdict: 'oops' } })
    expect(status).toBe(400)
  })
})

describe('GET /v2/annotation-queues/{queue_id}/next-listwise', () => {
  it('成员被删到不足 3 张的组不发出去，并标完成', async () => {
    const ids = posts(6)
    const q = await requestJson(t.app, '/v2/annotation-queues/listwise', {
      method: 'POST',
      body: { name: 'q', dimensions: ['overall'], groups: [ids.slice(0, 3), ids.slice(3, 6)] },
    })
    t.sqlite.prepare('DELETE FROM posts WHERE id IN (?, ?)').run(ids[0], ids[1])
    const { status, body } = await requestJson(t.app, `/v2/annotation-queues/${q.body.id}/next-listwise`)
    expect(status).toBe(200)
    expect(body.map((i: { position: number }) => i.position)).toEqual([1])
    expect(body[0].posts).toHaveLength(3)
    const done = t.sqlite.prepare('SELECT done FROM listwise_queue_items WHERE queue_id = ? ORDER BY position').pluck().all(q.body.id)
    expect(done).toEqual([1, 0])
  })
})

describe('DELETE /v2/annotation-queues/{queue_id}', () => {
  it('删队列和全部项，已提交的判决留着；再删一次 404', async () => {
    const [a, b, c] = posts(3)
    const q = await requestJson(t.app, '/v2/annotation-queues/pairwise', {
      method: 'POST',
      body: { name: 'q', dimensions: ['overall'], pairs: [[a, b], [b, c]] },
    })
    await requestJson(t.app, '/v2/annotations/pairwise', {
      method: 'POST',
      body: { ...base, postA: a, postB: b, winner: 'a', queueId: q.body.id, queuePosition: 0 },
    })

    const res = await t.app.request(`/v2/annotation-queues/${q.body.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(count('annotation_queues')).toBe(0)
    expect(count('pairwise_queue_items')).toBe(0)
    expect(count('pairwise_annotations')).toBe(1)
    expect((await requestJson(t.app, '/v2/annotation-queues')).body).toEqual([])

    const again = await requestJson(t.app, `/v2/annotation-queues/${q.body.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect(again.body.error).toBe('QueueNotFoundError')
  })

  it('队列删掉之后，手里还拿着它的客户端提交照样成功（事件有效）', async () => {
    const [a, b] = posts(2)
    const q = await requestJson(t.app, '/v2/annotation-queues/pairwise', {
      method: 'POST',
      body: { name: 'q', dimensions: ['overall'], pairs: [[a, b]] },
    })
    await t.app.request(`/v2/annotation-queues/${q.body.id}`, { method: 'DELETE' })
    const sub = await requestJson(t.app, '/v2/annotations/pairwise', {
      method: 'POST',
      body: { ...base, postA: a, postB: b, winner: 'a', queueId: q.body.id, queuePosition: 0 },
    })
    expect(sub.status).toBe(201)
  })
})

describe('limit / count 的上下界', () => {
  it.each([
    '/v2/annotations/timeline?limit=-1',
    '/v2/annotations/timeline?limit=101',
    '/v2/annotations/sample-absolute?dimensions=overall&limit=-1',
    '/v2/annotations/sample-pairwise?limit=0',
    '/v2/annotations/sample-pairwise?limit=100000',
    '/v2/annotations/sample-listwise?limit=-1',
    '/v2/annotation-queues/1/next-absolute?limit=-1',
    '/v2/annotation-queues/1/next-pairwise?limit=100000',
    '/v2/annotation-queues/1/next-listwise?limit=0',
  ])('%s → 400', async (url) => {
    const { status, body } = await requestJson(t.app, url)
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
  })

  it.each(['generate-absolute', 'generate-pairwise', 'generate-listwise'])('%s count 越界 → 400', async (kind) => {
    const body = kind === 'generate-absolute'
      ? { dimensions: ['overall'], scale: 5 }
      : { dimension: 'overall' }
    for (const n of [0, 5001]) {
      const res = await requestJson(t.app, `/v2/annotation-queues/${kind}`, { method: 'POST', body: { ...body, count: n } })
      expect(res.status).toBe(400)
    }
  })

  it('边界内的 limit 照常 200', async () => {
    expect((await requestJson(t.app, '/v2/annotations/timeline?limit=100')).status).toBe(200)
    expect((await requestJson(t.app, '/v2/annotation-queues/1/next-pairwise?limit=200')).status).toBe(200)
  })
})
