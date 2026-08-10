/**
 * `/v2/tags` —— 只搬了读端点（list / groups）。
 *
 * 四个写端点（create / update / delete / batch delete）仍然透传：它们要做存在性
 * 校验并抛领域错误，语义比读多一层，等读路径全部稳定再搬。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { listTagGroups, listTagsWithCounts } from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { translateTag } from '../tag-i18n.js'

const TagGroupPublic = z
  .object({ id: z.int(), name: z.string(), color: z.string() })
  .openapi('TagGroupPublic')

// 注意字段顺序：name → group → translatedName → count，与 baseline 一致。
const TagWithCountPublic = z
  .object({
    name: z.string(),
    group: z.union([TagGroupPublic, z.null()]).optional(),
    translatedName: z.string().nullable().optional(),
    count: z.int(),
  })
  .openapi('TagWithCountPublic')

export const tagsRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

tagsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/tags',
    operationId: 'v2ListTags',
    summary: 'ListTags',
    description: 'List tags with post counts; cursor-paginated by tag name.',
    request: {
      query: z.object({
        prev: z.string().max(200).nullable().optional()
          .openapi({ param: { name: 'prev', in: 'query', required: false } }),
        // type 覆盖必须带上 null —— coerce 会让 schema 变成 number，但直接写
        // { type: 'integer' } 会把 nullable 一起覆盖掉，contract-diff 会报。
        limit: z.coerce.number().int().nullable().optional()
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: ['integer', 'null'] }),
        lang: z.string().default('zh-Hans')
          .openapi({ param: { name: 'lang', in: 'query', required: false } }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(TagWithCountPublic) } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { prev, limit, lang } = c.req.valid('query')
    const rows = listTagsWithCounts(getDb().sqlite, { prev, limit })
    return c.json(
      rows.map(r => ({
        name: r.name,
        group: r.group,
        translatedName: translateTag(r.name, lang),
        count: r.count,
      })),
    )
  },
)

tagsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/tags/groups',
    operationId: 'v2ListTagGroup',
    summary: 'ListTagGroup',
    description: 'List all tag groups.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(TagGroupPublic) } } },
    },
  }),
  c => c.json(listTagGroups(getDb().sqlite)),
)
