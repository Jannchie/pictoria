/**
 * `/v2/posts/count*` 与 `/v2/posts/stats` —— 过滤后的计数与聚合。
 * 全是 `POST` + `PostFilter` 请求体、只读、无副作用。
 *
 * 查询全部走读线程（`c.var.reads`，见 `read-pool.ts` / `read-fns.ts`）：它们扫的是整个
 * 过滤集，带过滤的 tag facet 在真库上冷算要 0.3–8 s，在主线程上跑就是整个 API 停摆这么久。
 * 结果按数据版本缓存（`read-cache.ts`），客户端断开的请求不再派发（`withSignal`）。
 */
import { createRoute, z } from '@hono/zod-openapi'
import {
  FILTERABLE_SCORERS,
  pascalKey,
  urlSlug,
  type PostFilter as DbPostFilter,
} from '@pictoria/db'
import { newRoutes } from '../env.js'
import { PostFilterSchema as PostFilter, TagCountRequestSchema as TagCountRequest } from '../filter-schema.js'
import { OK, errors } from '../openapi.js'
import { searchTagsByTranslation, translateTag } from '../tag-i18n.js'

const CountPostsResponse = z.object({ count: z.int() }).openapi('CountPostsResponse')
const RatingCountItem = z.object({ rating: z.int(), count: z.int() }).openapi('RatingCountItem')
const ScoreCountItem = z.object({ score: z.int(), count: z.int() }).openapi('ScoreCountItem')
const ExtensionCountItem = z.object({ extension: z.string(), count: z.int() }).openapi('ExtensionCountItem')
/** 分档计数的一项。形状全都一样，每个打分器一个组件名（`<Pascal>BucketCountItem`），沿用历史契约。 */
function bucketCountItem(pascal: string) {
  return z.object({ bucket: z.string(), count: z.int() }).openapi(`${pascal}BucketCountItem`)
}
const TagCountItem = z
  .object({ tagName: z.string(), count: z.int(), translatedName: z.string().nullable().optional() })
  .openapi('TagCountItem')

const PostStatsResponse = z
  .object({
    total: z.int(),
    avgScore: z.number().nullable().optional(),
    scoredCount: z.int(),
    ratingDistribution: z.array(RatingCountItem),
  })
  .openapi('PostStatsResponse')

export const postCountsRoutes = newRoutes()

function filterBody() {
  return { required: true, content: { 'application/json': { schema: PostFilter } } }
}

function jsonOk(schema: z.ZodType) {
  return {
    200: { description: OK, content: { 'application/json': { schema } } },
    ...errors(400),
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
  async c => c.json({ count: await c.var.reads.countPosts(c.req.valid('json') as DbPostFilter) }, 200),
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
    async c => c.json(await c.var.reads.countByColumn(facet.column, c.req.valid('json') as DbPostFilter), 200),
  )
}

/**
 * 分档 facet：每个可筛打分器一条，路径 / operationId / 组件名都由注册项派生。
 */
const bucketFacets = FILTERABLE_SCORERS.map(scorer => ({
  path: `/v2/posts/count/${urlSlug(scorer)}`,
  id: `v2Get${pascalKey(scorer)}BucketCount`,
  scorer,
  desc: `Count posts by ${scorer.label} aesthetic bucket (A/B/C/D/E/UNSCORED).`,
  schema: bucketCountItem(pascalKey(scorer)),
}))

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
    async c => c.json(await c.var.reads.countByScorerBucket(c.req.valid('json') as DbPostFilter, facet.scorer.name), 200),
  )
}

postCountsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/stats',
    operationId: 'v2GetPostsStats',
    summary: 'GetPostsStats',
    description: 'Aggregate quality stats (avg score, rating distribution) for posts matching filter.',
    request: { body: filterBody() },
    responses: jsonOk(PostStatsResponse),
  }),
  async (c) => {
    const s = await c.var.reads.aggregateStats(c.req.valid('json') as DbPostFilter)
    return c.json({
      total: s.total,
      avgScore: s.avg_score,
      scoredCount: s.scored_count,
      ratingDistribution: s.rating_distribution,
    }, 200)
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
  async (c) => {
    // 搜索框的三个字段摘掉，剩下的才是过滤器：结果缓存按过滤器签名（`read-cache.ts`），
    // 敲字只换 query，不该让它算成另一个过滤器。
    const { query, limit, lang, ...filter } = c.req.valid('json')
    const rows = await c.var.reads.countByTag(filter as DbPostFilter, {
      query: query ?? '',
      limit: limit ?? 50,
      extraNames: searchTagsByTranslation(query ?? '', lang ?? 'zh-Hans'),
    })
    return c.json(rows.map(r => ({
      tagName: r.tag_name,
      count: r.count,
      translatedName: translateTag(r.tag_name, lang ?? 'zh-Hans'),
    })), 200)
  },
)
