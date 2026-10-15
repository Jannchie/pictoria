/**
 * `/v2/annotations` 的入口校验。
 *
 * 跨字段规则（value <= scale、listwise 的排列约束）挪进了 zod schema，失败时必须和其它
 * schema 错误回同一个 ErrorBody —— 400、`error: 'ValidationError'`、`issues` 指到字段。
 * 这些请求都在 schema 层被拒，handler 不会执行，所以不碰任何库。
 */
import { describe, expect, it } from 'vitest'
import { annotationsRoutes } from './annotations.js'

async function post(path: string, body: unknown) {
  const res = await annotationsRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { error: string, detail: string, issues?: Array<{ path: string, message: string }> } }
}

const base = { dimension: 'overall', rubricVersion: 'v1', sessionId: 's' }

describe('POST /v2/annotations/absolute', () => {
  it('value 超出 scale → 400 ValidationError，issue 指到 events.N.value', async () => {
    const { status, body } = await post('/v2/annotations/absolute', {
      events: [{ ...base, postId: 1, scale: 5, value: 5 }, { ...base, postId: 1, scale: 3, value: 4 }],
    })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(body.issues).toEqual([{ path: 'events.1.value', message: 'value 4 out of range for scale 3' }])
  })
})

describe('POST /v2/annotations/listwise', () => {
  it('postIds 重复 → 400，issue 指到 postIds', async () => {
    const { status, body } = await post('/v2/annotations/listwise', { ...base, postIds: [1, 1, 2], ranking: [] })
    expect(status).toBe(400)
    expect(body.error).toBe('ValidationError')
    expect(body.issues?.map(i => i.path)).toEqual(['postIds'])
  })

  it('ranking 不是 postIds 的排列 → 400，issue 指到 ranking', async () => {
    const { status, body } = await post('/v2/annotations/listwise', { ...base, postIds: [1, 2, 3], ranking: [1, 2, 9] })
    expect(status).toBe(400)
    expect(body.issues).toEqual([{ path: 'ranking', message: 'ranking must be a permutation of postIds (or [] to skip)' }])
  })
})

describe('GET /v2/annotations/timeline', () => {
  it('游标格式不对 → 400 ValidationError（在碰库之前）', async () => {
    const res = await annotationsRoutes.request('/v2/annotations/timeline?before=nope')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('ValidationError')
  })
})
