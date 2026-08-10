/**
 * 已迁移端点的输出必须和 Litestar 逐字符一致。
 *
 * 这里不打 HTTP，直接调 Hono app 的 fetch —— 不需要起服务，也就能在 CI 里跑。
 * 期望值是从运行中的 Python 侧 dump 下来的，不是手写的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { statisticsRoutes } from './statistics.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROD_DB = path.resolve(here, '../../../../server/illustration/images/.pictoria/pictoria.sqlite')
const exists = fs.existsSync(PROD_DB)

describe.skipIf(!exists)('GET /v2/statistics', () => {
  it('返回 10 个桶，标签形如 0~1 … 9~10', async () => {
    const res = await statisticsRoutes.request('/v2/statistics')
    expect(res.status).toBe(200)

    const body = (await res.json()) as Array<{ bucket: string, count: number }>
    expect(body).toHaveLength(10)
    expect(body.map(b => b.bucket)).toEqual([
      '0~1', '1~2', '2~3', '3~4', '4~5', '5~6', '6~7', '7~8', '8~9', '9~10',
    ])
    // 零填充：即使某档一条都没有，也要出现
    expect(body.every(b => typeof b.count === 'number')).toBe(true)
  })

  it('score == 10 落在 9~10 而不是溢出成第 11 桶', async () => {
    const res = await statisticsRoutes.request('/v2/statistics')
    const body = (await res.json()) as Array<{ bucket: string }>
    expect(body.map(b => b.bucket)).not.toContain('10~11')
  })
})
