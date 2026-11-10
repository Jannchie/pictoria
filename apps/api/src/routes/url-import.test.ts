/**
 * URL 导入（gallery-dl）的去重判据与分块落库。
 *
 * 判据是"已被导入器持久化过"（`source != ''`），不是"行存在"：下载中途失败后 sync 建的
 * 裸行必须在重跑里重新被认作新的，否则它们的标签永远补不上。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { syncSettled } from '../sync.js'
import { createTestApp, fakeTasks, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp | undefined

afterEach(async () => {
  await syncSettled()
  t?.close()
  t = undefined
})

async function settled(app: TestApp['app']) {
  for (let i = 0; i < 200; i++) {
    const { body } = await requestJson(app, '/v2/cmd/import-from-url/status')
    if (body.state !== 'running')
      return body
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('URL 导入一直停在 running')
}

const DIR = 'yandere/x'

function item(fileName: string) {
  return {
    downloadUrl: `https://cdn.example.com/${fileName}.jpg`,
    fileName,
    extension: 'jpg',
    source: `https://example.com/post/${fileName}`,
    category: 'yandere',
    creator: 'x',
    rating: 0,
    publishedAt: null,
    tagsByCategory: { general: ['blue_sky'] },
  }
}

/** worker 的 url-download：把收到的项原样当作"已落盘"回成行（`failOn` 里的块抛错）。 */
function downloadReply(payload: any, groupId: number) {
  return {
    rows: payload.items.map((it: any) => ({
      filePath: DIR,
      fileName: it.fileName,
      extension: it.extension,
      source: it.source,
      rating: 0,
      publishedAt: null,
      tags: { blue_sky: groupId },
    })),
    downloaded: payload.items.length,
    failed: 0,
  }
}

function tagsOf(fileName: string): string[] {
  return t!.sqlite
    .prepare("SELECT pht.tag_name FROM posts p JOIN post_has_tag pht ON pht.post_id = p.id WHERE p.file_path = ? AND p.file_name = ?")
    .pluck()
    .all(DIR, fileName) as string[]
}

describe('POST /v2/cmd/import-from-url', () => {
  it('sync 建的裸行（source 为空）仍算新的，被重新下载并补上标签；导入器写过的行跳过', async () => {
    const downloaded: string[][] = []
    const tasks = fakeTasks((task, payload) => {
      if (task === 'url-scan')
        return { fetched: 3, items: [item('a'), item('b'), item('c')], filePath: DIR }
      downloaded.push(payload.items.map((i: any) => i.fileName))
      return downloadReply(payload, Object.values(payload.typeToGroupId)[0] as number)
    })
    t = createTestApp({ tasks })
    // a：上一次下载中途失败、由 sync 建出的裸行；b：上一次导入器已经持久化过
    t.insertPost(DIR, 'a', 'jpg')
    t.insertPost(DIR, 'b', 'jpg', { source: 'https://example.com/post/b' })

    await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/x', { method: 'POST' })
    const body = await settled(t.app)
    expect(body).toMatchObject({ state: 'done', stats: { images: 3, new: 2, downloaded: 2, failed: 0 } })
    expect(downloaded.flat().sort()).toEqual(['a', 'c'])
    expect(tagsOf('a')).toEqual(['blue_sky'])
    expect(tagsOf('c')).toEqual(['blue_sky'])
    expect(t.sqlite.prepare("SELECT source FROM posts WHERE file_name = 'a'").pluck().get()).toBe('https://example.com/post/a')
  })

  it('分块下载、每块落库：一块失败，其余块的行照样带标签落库', async () => {
    const items = Array.from({ length: 120 }, (_, i) => item(`n${i}`))
    let calls = 0
    const tasks = fakeTasks((task, payload) => {
      if (task === 'url-scan')
        return { fetched: 120, items, filePath: DIR }
      calls += 1
      if (calls === 2)
        throw new Error('worker timed out')
      return downloadReply(payload, Object.values(payload.typeToGroupId)[0] as number)
    })
    t = createTestApp({ tasks })

    await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/x', { method: 'POST' })
    const body = await settled(t.app)
    expect(calls).toBe(3) // 50 + 50 + 20
    expect(body).toMatchObject({ state: 'done', stats: { new: 120, downloaded: 70, failed: 50 } })
    expect(t.sqlite.prepare("SELECT COUNT(*) FROM posts WHERE file_path = ? AND source != ''").pluck().get(DIR)).toBe(70)
    expect(tagsOf('n0')).toEqual(['blue_sky'])
    expect(tagsOf('n50')).toEqual([]) // 失败的那一块
  })

  it('每一块都失败 → failed，带原因', async () => {
    const tasks = fakeTasks((task) => {
      if (task === 'url-scan')
        return { fetched: 1, items: [item('a')], filePath: DIR }
      throw new Error('worker gone')
    })
    t = createTestApp({ tasks })
    await requestJson(t.app, '/v2/cmd/import-from-url?url=https://example.com/x', { method: 'POST' })
    const body = await settled(t.app)
    expect(body.state).toBe('failed')
    expect(body.error).toContain('worker gone')
  })
})
