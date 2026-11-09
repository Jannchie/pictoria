/**
 * `/v2/cmd/*` 里能在没有 worker 的情况下验证的部分。
 *
 * 需要 cairnq 的端点用 `fakeTasks` 注入一个假的队列：记下提交、按脚本回结果。这样
 * 守住的是 TS 这一侧的职责 —— 守卫顺序、命中缓存不提交、结果落库、错误的措辞 ——
 * 而不碰 GPU。
 */
import fs from 'node:fs'
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

describe('GET /v2/cmd/waifu-scorer/{post_id}', () => {
  it('post 不存在 → 404，不提交任务', async () => {
    const { t, tasks } = setup()
    const { status, body } = await requestJson(t.app, '/v2/cmd/waifu-scorer/42')
    expect(status).toBe(404)
    expect(body.error).toBe('PostNotFoundError')
    expect(tasks.calls).toEqual([])
  })

  it('不是图片 → 400 NotAnImageError，不提交任务', async () => {
    const { t, tasks } = setup()
    const id = t.insertPost('.', 'notes', 'txt')
    const { status, body } = await requestJson(t.app, `/v2/cmd/waifu-scorer/${id}`)
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'NotAnImageError', detail: `Post ${id} is not an image.` })
    expect(tasks.calls).toEqual([])
  })

  it('已有分 → 直接回存的，不重算', async () => {
    const { t, tasks } = setup()
    const id = t.insertPost('.', 'a', 'png')
    t.sqlite.prepare('INSERT INTO post_waifu_scores (post_id, score) VALUES (?, ?)').run(id, 6.25)
    const { status, body } = await requestJson(t.app, `/v2/cmd/waifu-scorer/${id}`)
    expect({ status, body }).toEqual({ status: 200, body: 6.25 })
    expect(tasks.calls).toEqual([])
  })

  it('没有分 → 提交一次 waifu 任务、落库、回新分', async () => {
    const { t, tasks } = setup((_task, payload) => ({
      scores: payload.items.map((i: { postId: number }) => ({ postId: i.postId, score: 7.5 })),
      failures: [],
    }))
    const id = t.insertPost('art', 'a', 'png')
    const { status, body } = await requestJson(t.app, `/v2/cmd/waifu-scorer/${id}`)
    expect({ status, body }).toEqual({ status: 200, body: 7.5 })
    expect(tasks.calls).toHaveLength(1)
    expect(tasks.calls[0]!.task).toBe('waifu')
    expect(tasks.calls[0]!.opts.key).toBe(`waifu:one:${id}`)
    expect(t.sqlite.prepare('SELECT score FROM post_waifu_scores WHERE post_id = ?').pluck().get(id)).toBe(7.5)
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

describe('POST /v2/cmd/db/snapshot', () => {
  it('201，回一份可打开的快照路径', async () => {
    const { t } = setup()
    t.insertPost('.', 'a', 'png')
    const { status, body } = await requestJson<{ path: string, dir: string }>(t.app, '/v2/cmd/db/snapshot', { method: 'POST' })
    try {
      expect(status).toBe(201)
      expect(fs.existsSync(body.path)).toBe(true)
      expect(fs.statSync(body.path).size).toBeGreaterThan(0)
    }
    finally {
      fs.rmSync(body.dir, { recursive: true, force: true })
    }
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
