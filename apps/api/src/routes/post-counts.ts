/**
 * `/v2/posts/count*` 与 `/v2/posts/stats` —— 过滤后的计数与聚合。
 *
 * 这一组全是 `POST` + `PostFilter` 请求体、只读、无副作用，是 posts 这 29 个端点里
 * 最适合先搬的一批：请求体形状统一，输出都是标量或小数组，对拍成本低。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  aggregateStats,
  countByColumn,
  countByScorerBucket,
  countPosts,
  SILVA,
  SILVA_LUNA,
  type PostFilter as DbPostFilter,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400 } from '../openapi.js'

/**
 * 全字段 snake_case —— 这一族在 Python 侧是 msgspec Struct，不走 to_camel
 * （见 §4.2 的命名风格表）。别顺手改成 camelCase。
 */
const PostFilter = z
  .object({
    rating: z.array(z.int()).default([]).nullable().optional(),
    score: z.array(z.int()).default([]).nullable().optional(),
    tags: z.array(z.string()).default([]).nullable().optional(),
    extension: z.array(z.string()).default([]).nullable().optional(),
    folder: z.string().nullable().optional(),
    lab: z.tuple([z.number(), z.number(), z.number()]).nullable().optional(),
    waifu_score_range: z.tuple([z.number(), z.number()]).nullable().optional(),
    waifu_score_levels: z.array(z.string()).default([]).nullable().optional(),
    silva_score_levels: z.array(z.string()).default([]).nullable().optional(),
    silva_luna_score_levels: z.array(z.string()).default([]).nullable().optional(),
    only_canonical: z.boolean().default(true).optional(),
  })
  .openapi('PostFilter')

const CountPostsResponse = z.object({ count: z.int() }).openapi('CountPostsResponse')
const RatingCountItem = z.object({ rating: z.int(), count: z.int() }).openapi('RatingCountItem')
const ScoreCountItem = z.object({ score: z.int(), count: z.int() }).openapi('ScoreCountItem')
const ExtensionCountItem = z.object({ extension: z.string(), count: z.int() }).openapi('ExtensionCountItem')
const WaifuBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('WaifuBucketCountItem')
const SilvaBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('SilvaBucketCountItem')
const SilvaLunaBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('SilvaLunaBucketCountItem')

// 注意 camelCase：PostStatsResponse 继承 DTOBaseModel（alias_generator=to_camel），
// 和上面 snake_case 的 PostFilter 在同一个请求里并存。
const PostStatsResponse = z
  .object({
    total: z.int(),
    avgScore: z.number().nullable().optional(),
    scoredCount: z.int(),
    avgWaifuScore: z.number().nullable().optional(),
    waifuCount: z.int(),
    ratingDistribution: z.array(RatingCountItem),
  })
  .openapi('PostStatsResponse')

export const postCountsRoutes = new OpenAPIHono()

function filterBody() {
  return { required: true, content: { 'application/json': { schema: PostFilter } } }
}

function jsonOk(schema: z.ZodType) {
  return {
    200: { description: OK, content: { 'application/json': { schema } } },
    ...RESP_400,
  }
}

postCountsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/count',
    operationId: 'v2GetPostsCount',
    summary: 'GetPostsCount',
    description: 'Count posts by filters.',
    request: { body: filterBody() },
    responses: jsonOk(CountPostsResponse),
  }),
  c => c.json({ count: countPosts(getDb().sqlite, c.req.valid('json') as DbPostFilter) }),
)

/** rating / score / extension 三个都是同一条 GROUP BY，只是列不同。 */
const columnFacets = [
  { path: '/v2/posts/count/rating', id: 'v2GetRatingCount', column: 'rating', desc: 'Count posts by rating.', schema: RatingCountItem },
  { path: '/v2/posts/count/score', id: 'v2GetScoreCount', column: 'score', desc: 'Count posts by score.', schema: ScoreCountItem },
  { path: '/v2/posts/count/extension', id: 'v2GetExtensionCount', column: 'extension', desc: 'Count posts by extension.', schema: ExtensionCountItem },
] as const

for (const facet of columnFacets) {
  postCountsRoutes.openapi(
    createRoute({
      method: 'post',
      path: facet.path,
      operationId: facet.id,
      summary: facet.id.replace(/^v2/, ''),
      description: facet.desc,
      request: { body: filterBody() },
      responses: jsonOk(z.array(facet.schema)),
    }),
    c => c.json(countByColumn(getDb().sqlite, facet.column, c.req.valid('json') as DbPostFilter)),
  )
}

/** 三个分档 facet：waifu 走独立表，两个 silva 走 post_aesthetic_scores。 */
const bucketFacets = [
  { path: '/v2/posts/count/waifu', id: 'v2GetWaifuBucketCount', scorer: null, desc: "Count posts by waifu-score bucket (A/B/C/D/E/UNSCORED).", schema: WaifuBucketCountItem },
  { path: '/v2/posts/count/silva', id: 'v2GetSilvaBucketCount', scorer: SILVA, desc: 'Count posts by SILVA aesthetic bucket (A/B/C/D/E/UNSCORED).', schema: SilvaBucketCountItem },
  { path: '/v2/posts/count/silva-luna', id: 'v2GetSilvaLunaBucketCount', scorer: SILVA_LUNA, desc: 'Count posts by SILVA-Luna aesthetic bucket (A/B/C/D/E/UNSCORED).', schema: SilvaLunaBucketCountItem },
] as const

for (const facet of bucketFacets) {
  postCountsRoutes.openapi(
    createRoute({
      method: 'post',
      path: facet.path,
      operationId: facet.id,
      summary: facet.id.replace(/^v2/, ''),
      description: facet.desc,
      request: { body: filterBody() },
      responses: jsonOk(z.array(facet.schema)),
    }),
    c => c.json(countByScorerBucket(getDb().sqlite, c.req.valid('json') as DbPostFilter, facet.scorer)),
  )
}

postCountsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/stats',
    operationId: 'v2GetPostsStats',
    summary: 'GetPostsStats',
    description: 'Aggregate quality stats (avg score, avg waifu, rating distribution) for posts matching filter.',
    request: { body: filterBody() },
    responses: jsonOk(PostStatsResponse),
  }),
  (c) => {
    const s = aggregateStats(getDb().sqlite, c.req.valid('json') as DbPostFilter)
    return c.json({
      total: s.total,
      avgScore: s.avg_score,
      scoredCount: s.scored_count,
      avgWaifuScore: s.avg_waifu_score,
      waifuCount: s.waifu_count,
      ratingDistribution: s.rating_distribution,
    })
  },
)
