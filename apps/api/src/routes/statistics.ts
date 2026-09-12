/** `/v2/statistics` —— waifu 分数直方图。 */
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
    // 标签形如 "0~1" … "9~10"。
    const body = waifuScoreDistribution(sqlite).map(({ bucket, count }) => ({
      bucket: `${bucket}~${bucket + 1}`,
      count,
    }))
    return c.json(body)
  },
)
