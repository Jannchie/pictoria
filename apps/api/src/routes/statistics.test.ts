/**
 * `/v2/statistics` 的桶标签与桶数。
 *
 * 打整条 `createApp` 栈，库是跑完迁移的内存库（`testing/app.ts`），不碰生产库。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, requestJson, type TestApp } from '../testing/app.js'

let t: TestApp

beforeEach(() => {
  t = createTestApp()
})

afterEach(() => t.close())

function waifu(score: number): void {
  const id = t.insertPost('.', `w${score}`, 'png')
  t.sqlite.prepare('INSERT INTO post_waifu_scores (post_id, score) VALUES (?, ?)').run(id, score)
}

describe('GET /v2/statistics', () => {
  it('返回 10 个桶，标签形如 0~1 … 9~10；空库也零填充', async () => {
    const { status, body } = await requestJson<Array<{ bucket: string, count: number }>>(t.app, '/v2/statistics')
    expect(status).toBe(200)
    expect(body.map(b => b.bucket)).toEqual([
      '0~1', '1~2', '2~3', '3~4', '4~5', '5~6', '6~7', '7~8', '8~9', '9~10',
    ])
    expect(body.every(b => b.count === 0)).toBe(true)
  })

  it('按整数宽分桶，score == 10 落在 9~10 而不是溢出成第 11 桶', async () => {
    for (const s of [0.5, 3.2, 3.9, 9.5, 10])
      waifu(s)
    const { body } = await requestJson<Array<{ bucket: string, count: number }>>(t.app, '/v2/statistics')
    expect(body).toHaveLength(10)
    const counts = Object.fromEntries(body.map(b => [b.bucket, b.count]))
    expect(counts).toMatchObject({ '0~1': 1, '3~4': 2, '9~10': 2 })
    expect(counts['10~11']).toBeUndefined()
  })
})
