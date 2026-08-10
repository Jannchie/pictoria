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
  countByTag,
  countPosts,
  SILVA,
  SILVA_LUNA,
  type PostFilter as DbPostFilter,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { PostFilterSchema as PostFilter, TagCountRequestSchema as TagCountRequest } from '../filter-schema.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { searchTagsByTranslation, translateTag } from '../tag-i18n.js'

const CountPostsResponse = z.object({ count: z.int() }).openapi('CountPostsResponse')
const RatingCountItem = z.object({ rating: z.int(), count: z.int() }).openapi('RatingCountItem')
const ScoreCountItem = z.object({ score: z.int(), count: z.int() }).openapi('ScoreCountItem')
const ExtensionCountItem = z.object({ extension: z.string(), count: z.int() }).openapi('ExtensionCountItem')
const WaifuBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('WaifuBucketCountItem')
const SilvaBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('SilvaBucketCountItem')
const SilvaLunaBucketCountItem = z.object({ bucket: z.string(), count: z.int() }).openapi('SilvaLunaBucketCountItem')
// 键序照抄 baseline：tag_name → count → translated_name。
const TagCountItem = z
  .object({ tag_name: z.string(), count: z.int(), translated_name: z.string().nullable().optional() })
  .openapi('TagCountItem')

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

export const postCountsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

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

/**
 * tag facet —— 唯一一个不吃 `PostFilter` 而吃 `TagCountRequest` 的计数端点。
 *
 * 它多出来的三个字段（query / limit / lang）都服务于同一件事：可搜索的下拉框。
 * 本地化搜索在这一层解决 —— 把显示名的命中（"绿眼"）解析成 DB 里的 tag 名
 * （`green_eyes`）再传给查询，于是用户打哪种形式都能匹配上。查询层本身对翻译
 * 一无所知。
 */
postCountsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/count/tags',
    operationId: 'v2GetTagCount',
    summary: 'GetTagCount',
    description: 'Count posts per tag (searchable, top-N by count).',
    request: { body: { required: true, content: { 'application/json': { schema: TagCountRequest } } } },
    responses: jsonOk(z.array(TagCountItem)),
  }),
  (c) => {
    const data = c.req.valid('json')
    const rows = countByTag(getDb().sqlite, data as DbPostFilter, {
      query: data.query ?? '',
      limit: data.limit ?? 50,
      extraNames: searchTagsByTranslation(data.query ?? '', data.lang ?? 'zh-Hans'),
    })
    return c.json(rows.map(r => ({
      tag_name: r.tag_name,
      count: r.count,
      translated_name: translateTag(r.tag_name, data.lang ?? 'zh-Hans'),
    })))
  },
)
