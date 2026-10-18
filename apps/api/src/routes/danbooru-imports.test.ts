/**
 * `/v2/danbooru-imports` 与它背后的作业队列。
 *
 * worker 用 `fakeTasks` 顶替：`danbooru-list` 回一份脚本里的列表，`danbooru-download`
 * 把收到的项原样当成"已落盘"回传。需要卡住某一步时，reply 返回一个由测试手动放行的
 * Promise。守的是 TS 这一侧的职责：去重、并发上限、分块落库、失败的收尾。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, fakeTasks, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp | undefined

afterEach(async () => {
  // 先等后台作业收尾再关库，否则还在跑的作业会往一个已关闭的连接上落库。
  await t?.danbooruImports.idle()
  t?.close()
  t = undefined
})

type Reply = (task: string, payload: any) => unknown

function setup(reply: Reply, opts: { concurrency?: number, chunkSize?: number, maxRetained?: number } = {}) {
  const tasks = fakeTasks(reply)
  t = createTestApp({ tasks, danbooruImports: opts })
  return { t, tasks }
}

/** 一个由测试手动 resolve / reject 的 Promise。 */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 一条列表项。tag 映射用 worker 收到的 `typeToGroupId`，和真 worker 一样。 */
function item(id: number, payload: any) {
  return {
    fileUrl: `https://cdn.donmai.us/${id}.png`,
    fileSize: 3,
    row: {
      filePath: payload.filePathStr,
      fileName: String(id),
      extension: 'png',
      source: `https://danbooru.donmai.us/posts/${id}`,
      rating: 1,
      publishedAt: null,
      tags: { some_artist: payload.typeToGroupId.artist },
    },
  }
}

function listing(payload: any, ids: number[]) {
  return {
    items: ids.map(id => item(id, payload)),
    stats: { total: ids.length + 1, withUrl: ids.length + 1, filtered: ids.length + 1, earlyStopped: false },
  }
}

/** 把收到的项当作全部落盘。 */
function downloadAll(payload: any) {
  return { rows: payload.items.map((i: any) => i.row), downloaded: payload.items.length, skipped: 0, failed: 0 }
}

function postCount(t: TestApp): number {
  return (t.sqlite.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
}

function submit(t: TestApp, tags: string, fullScan?: boolean) {
  return requestJson(t.app, '/v2/danbooru-imports', {
    method: 'POST',
    body: fullScan === undefined ? { tags } : { tags, fullScan },
  })
}

describe('POST /v2/danbooru-imports', () => {
  it('立即回 202 和作业，导入在后台跑完并落库', async () => {
    const { t, tasks } = setup((task, payload) =>
      task === 'danbooru-list' ? listing(payload, [1, 2]) : downloadAll(payload))

    const { status, body } = await submit(t, '  some_artist  ')
    expect(status).toBe(202)
    expect(body).toMatchObject({ tags: 'some_artist', fullScan: false, state: 'running', phase: 'listing' })

    await t.danbooruImports.idle()
    expect(t.danbooruImports.get(body.id)).toMatchObject({
      state: 'done',
      phase: null,
      total: 3,
      filtered: 3,
      pending: 2,
      processed: 2,
      downloaded: 2,
      // 列表里那条已导入过的（filtered - pending）。
      skipped: 1,
      failed: 0,
      error: null,
    })
    expect(postCount(t)).toBe(2)

    const list = tasks.calls[0]!
    expect(list.task).toBe('danbooru-list')
    expect(list.payload).toMatchObject({ tags: 'some_artist', fullScan: false, filePathStr: 'danbooru/some_artist', importedIds: [] })
    expect(list.opts).toMatchObject({ queue: 'io', maxAttempts: 1 })
    expect(tasks.calls[1]!.payload.saveDir.replaceAll('\\', '/')).toMatch(/\/danbooru\/some_artist$/)
  })

  it('tags 为空（trim 后）→ 400，不建作业', async () => {
    const { t, tasks } = setup(() => {
      throw new Error('should not be called')
    })
    const { status, body } = await submit(t, '   ')
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(t.danbooruImports.list()).toEqual([])
    expect(tasks.calls).toEqual([])
  })

  it('同 tag 重复提交 → 同一个作业，worker 只收到一次列表', async () => {
    const gate = deferred()
    const { t, tasks } = setup(async (task, payload) => {
      if (task === 'danbooru-list') {
        await gate.promise
        return listing(payload, [1])
      }
      return downloadAll(payload)
    })

    const first = await submit(t, 'some_artist')
    const second = await submit(t, 'some_artist')
    expect(second.status).toBe(202)
    expect(second.body.id).toBe(first.body.id)

    gate.resolve()
    await t.danbooruImports.idle()
    expect(tasks.calls.filter(c => c.task === 'danbooru-list')).toHaveLength(1)
    expect(t.danbooruImports.list()).toHaveLength(1)
  })

  it('结束后再提交是新作业，已导入 id 在作业开始跑时读', async () => {
    const { t, tasks } = setup((task, payload) =>
      task === 'danbooru-list' ? listing(payload, [1, 2]) : downloadAll(payload))

    const first = await submit(t, 'some_artist')
    await t.danbooruImports.idle()
    const second = await submit(t, 'some_artist')
    await t.danbooruImports.idle()

    expect(second.body.id).not.toBe(first.body.id)
    const lists = tasks.calls.filter(c => c.task === 'danbooru-list')
    expect(lists[1]!.payload.importedIds.sort()).toEqual(['1', '2'])
  })

  it('分块下载，每块回来就落库', async () => {
    const seenBeforeSecondChunk: number[] = []
    let chunks = 0
    const { t } = setup((task, payload) => {
      if (task === 'danbooru-list')
        return listing(payload, [1, 2, 3])
      chunks++
      if (chunks === 2)
        seenBeforeSecondChunk.push(postCount(t!))
      return downloadAll(payload)
    }, { chunkSize: 2 })

    const { body } = await submit(t, 'some_artist')
    await t.danbooruImports.idle()

    expect(chunks).toBe(2)
    // 第二块提交时第一块的两行已经在库里。
    expect(seenBeforeSecondChunk).toEqual([2])
    expect(postCount(t)).toBe(3)
    expect(t.danbooruImports.get(body.id)).toMatchObject({ state: 'done', processed: 3, downloaded: 3 })
  })

  it('一块失败整块计入 failed，后面的块照跑，作业仍是 done', async () => {
    let chunks = 0
    const { t } = setup((task, payload) => {
      if (task === 'danbooru-list')
        return listing(payload, [1, 2, 3])
      chunks++
      if (chunks === 1)
        throw new Error('worker died')
      return downloadAll(payload)
    }, { chunkSize: 2 })

    const { body } = await submit(t, 'some_artist')
    await t.danbooruImports.idle()

    expect(t.danbooruImports.get(body.id)).toMatchObject({
      state: 'done',
      processed: 3,
      downloaded: 1,
      failed: 2,
      error: 'Error: worker died',
    })
    expect(postCount(t)).toBe(1)
  })

  it('列表失败 → failed，带错误，不下载', async () => {
    const { t, tasks } = setup((task) => {
      if (task === 'danbooru-list')
        throw new Error('HTTP 500 from danbooru')
      throw new Error('should not download')
    })

    const { body } = await submit(t, 'some_artist')
    await t.danbooruImports.idle()

    const job = t.danbooruImports.get(body.id)!
    expect(job).toMatchObject({ state: 'failed', phase: null, error: 'Error: HTTP 500 from danbooru' })
    expect(job.finishedAt).not.toBeNull()
    expect(tasks.calls.map(c => c.task)).toEqual(['danbooru-list'])
  })

  it('没有待下载项也会收尾成 done', async () => {
    const { t, tasks } = setup((_task, payload) => listing(payload, []))
    const { body } = await submit(t, 'some_artist')
    await t.danbooruImports.idle()
    expect(t.danbooruImports.get(body.id)).toMatchObject({ state: 'done', pending: 0, processed: 0 })
    expect(tasks.calls.map(c => c.task)).toEqual(['danbooru-list'])
  })

  it('并发上限：concurrency=1 时第二个 tag 排队，直到第一个结束', async () => {
    const gates = new Map([['a', deferred()], ['b', deferred()]])
    const { t } = setup(async (task, payload) => {
      if (task === 'danbooru-list') {
        await gates.get(payload.tags)!.promise
        return listing(payload, [])
      }
      return downloadAll(payload)
    }, { concurrency: 1 })

    const a = await submit(t, 'a')
    const b = await submit(t, 'b')
    expect(a.body.state).toBe('running')
    expect(b.body.state).toBe('queued')

    gates.get('a')!.resolve()
    await new Promise(r => setTimeout(r, 0))
    expect(t.danbooruImports.get(a.body.id)!.state).toBe('done')
    expect(t.danbooruImports.get(b.body.id)!.state).toBe('running')

    gates.get('b')!.resolve()
    await t.danbooruImports.idle()
    expect(t.danbooruImports.get(b.body.id)!.state).toBe('done')
  })

  it('排队中的增量作业遇上 fullScan 请求 → 升级为 fullScan', async () => {
    const gate = deferred()
    const { t, tasks } = setup(async (_task, payload) => {
      if (payload.tags === 'a')
        await gate.promise
      return listing(payload, [])
    }, { concurrency: 1 })

    await submit(t, 'a')
    const queued = await submit(t, 'b')
    const upgraded = await submit(t, 'b', true)
    expect(upgraded.body).toMatchObject({ id: queued.body.id, fullScan: true, state: 'queued' })

    gate.resolve()
    await t.danbooruImports.idle()
    expect(tasks.calls.find(c => c.payload.tags === 'b')!.payload.fullScan).toBe(true)
  })
})

describe('GET /v2/danbooru-imports', () => {
  it('列出全部作业，最近创建的在前', async () => {
    const { t } = setup((_task, payload) => listing(payload, []))
    await submit(t, 'a')
    await submit(t, 'b')
    await t.danbooruImports.idle()

    const { status, body } = await requestJson(t.app, '/v2/danbooru-imports')
    expect(status).toBe(200)
    expect(body.jobs.map((j: any) => j.tags)).toEqual(['b', 'a'])
  })

  it('已结束的作业超过 maxRetained 时清掉最老的', async () => {
    const { t } = setup((_task, payload) => listing(payload, []), { maxRetained: 1 })
    await submit(t, 'a')
    await t.danbooruImports.idle()
    await submit(t, 'b')
    await t.danbooruImports.idle()
    expect(t.danbooruImports.list().map(j => j.tags)).toEqual(['b'])
  })
})

describe('GET /v2/danbooru-imports/{job_id}', () => {
  it('回作业本身', async () => {
    const { t } = setup((_task, payload) => listing(payload, []))
    const { body: created } = await submit(t, 'a')
    await t.danbooruImports.idle()

    const { status, body } = await requestJson(t.app, `/v2/danbooru-imports/${created.id}`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: created.id, tags: 'a', state: 'done' })
  })

  it('不存在 → 404，ErrorBody 形状', async () => {
    const { t } = setup(() => {
      throw new Error('should not be called')
    })
    const { status, body } = await requestJson(t.app, '/v2/danbooru-imports/nope')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'DanbooruImportNotFoundError', detail: 'Danbooru import nope not found.' })
  })
})
