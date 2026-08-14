/**
 * `/v2/statistics` —— Phase 4 搬过来的第一组（1 个端点）。
 *
 * 选它打头是因为它没有参数、没有请求体、只读一张表：整条链路（Hono 路由 →
 * packages/db → 契约对齐）能在最小的面上验证一遍。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { waifuScoreDistribution } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, zodErrorHook } from '../openapi.js'

const WaifuScoreResult = z
  .object({ bucket: z.string(), count: z.int() })
  .openapi('WaifuScoreResult')

export const statisticsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

statisticsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/statistics',
    operationId: 'v2GetWaifuScorerStatistics',
    summary: 'GetWaifuScorerStatistics',
    description: 'Histogram of waifu scores in 10 integer-wide buckets ``[0,1), …, [9,10]``.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(WaifuScoreResult) } } },
    },
  }),
  (c) => {
    const { sqlite } = getDb()
    // 标签形如 "0~1" … "9~10"，与 Python 侧 f"{b}~{b+1}" 一致。
    const body = waifuScoreDistribution(sqlite).map(({ bucket, count }) => ({
      bucket: `${bucket}~${bucket + 1}`,
      count,
    }))
    return c.json(body)
  },
)
