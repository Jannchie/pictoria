/**
 * `/v2/cmd/*` 里能在没有 worker 的情况下验证的部分。
 *
 * 需要 cairnq 的端点用 `fakeTasks` 注入一个假的队列：记下提交、按脚本回结果。这样
 * 守住的是 TS 这一侧的职责 —— 守卫顺序、命中缓存不提交、结果落库、错误的措辞 ——
 * 而不碰 GPU。
 */
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncSettled } from '../sync.js'
import { createTestApp, fakeTasks, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp | undefined

afterEach(() => {
  t?.close()
  t = undefined
})

function setup(reply?: (task: string, payload: any) => unknown) {
  const tasks = fakeTasks(reply)
  t = createTestApp({ tasks })
  return { t, tasks }
}

describe('GET /v2/cmd/silva-scorer/{post_id}', () => {
  /** 一个 1152 维向量的 base64，embedding 任务回包里的形状。 */
  const VECTOR_B64 = Buffer.from(new Float32Array(1152).fill(0.01).buffer).toString('base64')

  it('post 不存在 → 404，不提交任务', async () => {
    const { t, tasks } = setup()
    const { status, body } = await requestJson(t.app, '/v2/cmd/silva-scorer/42')
    expect(status).toBe(404)
    expect(body.error).toBe('PostNotFoundError')
    expect(tasks.calls).toEqual([])
  })

  it('不是图片 → 400 NotAnImageError，不提交任务', async () => {
    const { t, tasks } = setup()
    const id = t.insertPost('.', 'notes', 'txt')
    const { status, body } = await requestJson(t.app, `/v2/cmd/silva-scorer/${id}`)
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'NotAnImageError', detail: `Post ${id} is not an image.` })
    expect(tasks.calls).toEqual([])
  })

  it('已有分 → 直接回存的，不重算', async () => {
    const { t, tasks } = setup()
    const id = t.insertPost('.', 'a', 'png')
    t.sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, \'silva\', ?)').run(id, 0.625)
    const { status, body } = await requestJson(t.app, `/v2/cmd/silva-scorer/${id}`)
    expect({ status, body }).toEqual({ status: 200, body: 0.625 })
    expect(tasks.calls).toEqual([])
  })

  it('没有分也没有向量 → 先算向量再打分，各提交一次、落库、回新分', async () => {
    const { t, tasks } = setup((task, payload) => task === 'embedding'
      ? { embeddings: payload.items.map((i: { postId: number }) => ({ postId: i.postId, embedding: VECTOR_B64 })), failures: [] }
      : { scores: payload.items.map((i: { postId: number }) => ({ postId: i.postId, score: 0.75 })) })
    const id = t.insertPost('art', 'a', 'png')
    // 已退役打分器留下的分不算"已有分"：照样要算 silva 的
    t.sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, \'silva_luna\', 0.1)').run(id)
    const { status, body } = await requestJson(t.app, `/v2/cmd/silva-scorer/${id}`)
    expect({ status, body }).toEqual({ status: 200, body: 0.75 })
    expect(tasks.calls.map(c => [c.task, c.opts.key])).toEqual([
      ['embedding', `embedding:one:${id}`],
      ['silva', `silva:one:${id}`],
    ])
    expect(tasks.calls[1]!.payload.scorer).toBe('silva')
    expect(t.sqlite.prepare('SELECT scorer, score FROM post_aesthetic_scores WHERE post_id = ? ORDER BY scorer').all(id))
      .toEqual([{ scorer: 'silva', score: 0.75 }, { scorer: 'silva_luna', score: 0.1 }])
  })

  it('向量算不出来 → 400 NotAnImageError，不提交 silva 任务', async () => {
    const { t, tasks } = setup((_task, payload) => ({
      embeddings: [],
      failures: payload.items.map((i: { postId: number }) => ({ postId: i.postId, error: 'unreadable' })),
    }))
    const id = t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/cmd/silva-scorer/${id}`)
    expect(status).toBe(400)
    expect(body.error).toBe('NotAnImageError')
    expect(tasks.calls.map(c => c.task)).toEqual(['embedding'])
  })
})

// waifu / silva_luna 退役（2026-11）：单张打分端点不存在了。
describe('已退役打分器的单张打分端点', () => {
  it.each(['waifu-scorer', 'silva-luna-scorer'])('GET /v2/cmd/%s/{post_id} → 404，不提交任务', async (name) => {
    const { t, tasks } = setup()
    const id = t.insertPost('.', 'a', 'png')
    const res = await t.app.request(`/v2/cmd/${name}/${id}`)
    expect(res.status).toBe(404)
    expect(tasks.calls).toEqual([])
  })
})

describe('PUT /v2/cmd/auto-caption/{post_id}', () => {
  it('worker 回"没配 key" → 400 MissingConfigError，caption 不变', async () => {
    const { t } = setup(() => ({ configured: false, caption: '' }))
    const id = t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/cmd/auto-caption/${id}`, { method: 'PUT' })
    expect(status).toBe(400)
    expect(body.error).toBe('MissingConfigError')
    expect(t.sqlite.prepare('SELECT caption FROM posts WHERE id = ?').pluck().get(id)).toBe('')
  })

  it('成功 → 写进 caption 并回读详情', async () => {
    const { t, tasks } = setup(() => ({ configured: true, caption: 'a cat' }))
    const id = t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/cmd/auto-caption/${id}`, { method: 'PUT' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ id, caption: 'a cat' })
    expect(tasks.calls[0]!.payload.imagePath).toBe(path.join(t.root, 'a.png'))
  })
})

describe('GET /v2/cmd/import-from-url/status', () => {
  it('没跑过导入 → idle', async () => {
    const { t } = setup()
    const { status, body } = await requestJson(t.app, '/v2/cmd/import-from-url/status')
    expect(status).toBe(200)
    expect(body).toMatchObject({ state: 'idle', url: null, stats: null })
  })
})

describe('POST /v2/cmd/import-from-url', () => {
  /** 轮询到导入不再 running，返回那一次的状态。 */
  async function settled(app: TestApp['app']) {
    for (let i = 0; i < 100; i++) {
      const { body } = await requestJson(app, '/v2/cmd/import-from-url/status')
      if (body.state !== 'running')
        return body
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('URL 导入一直停在 running')
  }

  afterEach(async () => {
    // done 会踢一次同步；关库之前等它跑完。
    await syncSettled()
  })

  it('扫描没东西 → done，带 stats 和结束时间，没有 error', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { t } = setup(async () => {
      await gate
      return { fetched: 3, items: [], filePath: 'kemono/x' }
    })
    const post = await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/a', { method: 'POST' })
    expect(post.body.msg).toBe('Import started')

    // 扫描还没回来：running、没有 stats、没有结束时间；再提交一次不会开第二个。
    const running = await requestJson(t.app, '/v2/cmd/import-from-url/status')
    expect(running.body).toMatchObject({ state: 'running', url: 'https://example.com/a', stats: null, error: null, finishedAt: null })
    expect(running.body.startedAt).toEqual(expect.any(String))
    const again = await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/b', { method: 'POST' })
    expect(again.body.msg).toBe('Import already running')

    release()
    const body = await settled(t.app)
    expect(body).toMatchObject({
      state: 'done',
      url: 'https://example.com/a',
      stats: { fetched: 3, images: 0, new: 0, downloaded: 0, failed: 0 },
      error: null,
    })
    expect(body.finishedAt).toEqual(expect.any(String))
  })

  it('扫描抛错 → failed，带原因；下一次导入从干净的 running 开始', async () => {
    let fail = true
    const { t } = setup(async () => {
      if (fail)
        throw new Error('gallery-dl exploded')
      return { fetched: 0, items: [], filePath: 'kemono/x' }
    })
    await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/a', { method: 'POST' })
    const failed = await settled(t.app)
    expect(failed).toMatchObject({ state: 'failed', stats: null })
    expect(failed.error).toContain('gallery-dl exploded')
    expect(failed.finishedAt).toEqual(expect.any(String))

    fail = false
    await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/b', { method: 'POST' })
    const done = await settled(t.app)
    expect(done).toMatchObject({ state: 'done', url: 'https://example.com/b', error: null })
  })
})

describe('GET /v2/queues/status', () => {
  it('任务库没连上（peek 为 null）→ queues 为空数组，不触发开库', async () => {
    const { t } = setup()
    const { status, body } = await requestJson(t.app, '/v2/queues/status')
    expect(status).toBe(200)
    expect(body.queues).toEqual([])
    expect(Array.isArray(body.loops)).toBe(true)
  })
})

describe('POST /v2/cmd/import-from-url：只收 http(s)', () => {
  it.each(['file:///etc/passwd', '--exec=calc', '-o extractor.x=1', 'ftp://example.com/a', 'javascript:alert(1)', 'example.com/a'])('%s → 400，不提交任务', async (url) => {
    const { t, tasks } = setup()
    const { status, body } = await requestJson(t.app, `/v2/cmd/import-from-url?url=${encodeURIComponent(url)}`, { method: 'POST' })
    expect(status).toBe(400)
    expect(body.error).toBeDefined()
    expect(tasks.calls).toEqual([])
    // 状态是模块级的（前面的用例可能留下 done）：只断言没有因为这次请求开跑。
    const s = await requestJson(t.app, '/v2/cmd/import-from-url/status')
    expect(s.body.state).not.toBe('running')
    expect(s.body.url).not.toBe(url)
  })
})
