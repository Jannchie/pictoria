/** `/v2/statistics` —— waifu 分数直方图。 */
import { createRoute, z } from '@hono/zod-openapi'
import { waifuScoreDistribution } from '@pictoria/db'
import { newRoutes } from '../env.js'
import { OK } from '../openapi.js'

const WaifuScoreResult = z
  .object({ bucket: z.string(), count: z.int() })
  .openapi('WaifuScoreResult')

export const statisticsRoutes = newRoutes()

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
    const sqlite = c.var.db
    // 标签形如 "0~1" … "9~10"。
    const body = waifuScoreDistribution(sqlite).map(({ bucket, count }) => ({
      bucket: `${bucket}~${bucket + 1}`,
      count,
    }))
    return c.json(body)
  },
)
