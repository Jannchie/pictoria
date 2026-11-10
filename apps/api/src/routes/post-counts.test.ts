/**
 * 计数 / facet / 聚合端点与「未评分画师」都经读线程（`c.var.reads`）执行，不在主线程上跑。
 *
 * 这里注入一个记录调用的 `Reads`：每次调用先对参数做一次 `structuredClone` —— 读线程池
 * 就是这么把参数送过 `postMessage` 的，带方法的对象（比如 `ScorerSpec`）在这一步就会抛，
 * 而 `inProcessReads` 自己不会暴露这个问题。
 */
import type { Reads } from '../read-pool.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { inProcessReads } from '../read-pool.js'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp
let app: ReturnType<typeof createApp>
let calls: string[]

function recordingReads(inner: Reads): Reads {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function' || prop === 'close')
        return v
      // 每个请求拿的是挂了 abort signal 的那一份（`app.ts`）：signal 不过线程，接着记录那一份。
      if (prop === 'withSignal')
        return (signal: AbortSignal | undefined) => recordingReads(target.withSignal(signal))
      return (...args: unknown[]) => {
        calls.push(String(prop))
        return (v as (...a: unknown[]) => unknown)(...structuredClone(args))
      }
    },
  })
}

beforeEach(() => {
  t = createTestApp()
  calls = []
  app = createApp({ db: t.sqlite, tasks: t.tasks, reads: recordingReads(inProcessReads(t.sqlite)) })
  const tag = (id: number, name: string) => {
    t.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
    t.sqlite.prepare('INSERT INTO post_has_tag (post_id, tag_name) VALUES (?, ?)').run(id, name)
  }
  const a = t.insertPost('d', 'a', 'png', { rating: 1, score: 3 })
  const b = t.insertPost('d', 'b', 'jpg', { rating: 1 })
  const c = t.insertPost('d', 'c', 'png', { rating: 2 })
  tag(a, 'red')
  tag(b, 'red')
  tag(c, 'blue')
  t.sqlite.prepare('INSERT INTO post_waifu_scores (post_id, score) VALUES (?, 8.5)').run(a)
  t.sqlite.prepare("INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', 0.9)").run(a)
})

afterEach(() => t.close())

const post = (url: string, body: unknown) => requestJson(app, url, { method: 'POST', body })

describe('计数端点走读线程', () => {
  it('count / rating / score / extension', async () => {
    expect((await post('/v2/posts/count', { tags: ['red'] })).body).toEqual({ count: 2 })
    expect((await post('/v2/posts/count/rating', {})).body).toEqual([{ rating: 1, count: 2 }, { rating: 2, count: 1 }])
    expect((await post('/v2/posts/count/score', { tags: ['red'] })).body).toEqual([{ score: 0, count: 1 }, { score: 3, count: 1 }])
    expect((await post('/v2/posts/count/extension', {})).body).toEqual([{ extension: 'jpg', count: 1 }, { extension: 'png', count: 2 }])
    expect(calls).toEqual(['countPosts', 'countByColumn', 'countByColumn', 'countByColumn'])
  })

  it('分档计数按打分器名字过线程（spec 本身过不了结构化克隆）', async () => {
    const waifu = await post('/v2/posts/count/waifu', {})
    expect(waifu.status).toBe(200)
    expect(waifu.body.reduce((s: number, r: { count: number }) => s + r.count, 0)).toBe(3)
    const silva = await post('/v2/posts/count/silva', {})
    expect(silva.status).toBe(200)
    expect(silva.body).toContainEqual({ bucket: 'UNSCORED', count: 2 })
    const luna = await post('/v2/posts/count/silva-luna', {})
    expect(luna.body).toEqual([{ bucket: 'UNSCORED', count: 3 }])
    expect(calls).toEqual(['countByScorerBucket', 'countByScorerBucket', 'countByScorerBucket'])
  })

  it('stats 与 tag facet', async () => {
    const stats = await post('/v2/posts/stats', {})
    expect(stats.body).toMatchObject({ total: 3, scoredCount: 1, avgScore: 3, waifuCount: 1, avgWaifuScore: 8.5 })
    const tags = await post('/v2/posts/count/tags', { rating: [1], lang: 'en' })
    expect(tags.body).toEqual([expect.objectContaining({ tagName: 'red', count: 2 })])
    // 带过滤的 tag facet 在线程里取全量（慢通道），名字筛选 / 取前 N 在主线程上做。
    expect(calls).toEqual(['aggregateStats', 'countAllTags'])
  })

  it('没有内容过滤的 tag facet 走快路径（tags.post_count），不进慢通道', async () => {
    const tags = await post('/v2/posts/count/tags', { query: 'RE', lang: 'en' })
    expect(tags.body).toEqual([expect.objectContaining({ tagName: 'red', count: 2 })])
    expect(calls).toEqual(['countByTagFast'])
  })

  it('计数结果按数据版本缓存：同一过滤器第二次不再派发，任何写之后重算', async () => {
    const facet = () => post('/v2/posts/count/tags', { rating: [1, 2], lang: 'en' })
    expect((await facet()).body.map((r: { tagName: string, count: number }) => [r.tagName, r.count])).toEqual([['red', 2], ['blue', 1]])
    // 名字筛选在缓存的全量结果上做，也不再派发。
    expect((await post('/v2/posts/count/tags', { rating: [1, 2], query: 'BL', lang: 'en' })).body)
      .toEqual([expect.objectContaining({ tagName: 'blue', count: 1 })])
    await facet()
    expect((await post('/v2/posts/count', { rating: [1] })).body).toEqual({ count: 2 })
    await post('/v2/posts/count', { rating: [1] })
    expect(calls).toEqual(['countAllTags', 'countPosts'])

    t.sqlite.prepare('UPDATE posts SET rating = 2 WHERE file_name = ?').run('b')
    expect((await post('/v2/posts/count', { rating: [1] })).body).toEqual({ count: 1 })
    await facet()
    expect(calls).toEqual(['countAllTags', 'countPosts', 'countPosts', 'countAllTags'])
  })

  it('未评分画师的快照', async () => {
    const { status, body } = await requestJson(app, '/v2/posts/unrated-artist-picks')
    expect(status).toBe(200)
    expect(body).toEqual([])
    expect(calls).toEqual(['unratedArtistPickIds'])
  })
})
