/**
 * tag 的写操作：独立 tag 的增删改，以及 post ↔ tag 的关联。
 *
 * 每个都有存在性校验，各自抛不同状态码的领域错误 —— 全部照抄
 * `server/exceptions.py` 里声明的那个码，不"统一"成 400/404。
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  addTagToPost,
  createTag,
  deleteTag,
  deleteTags,
  getDetail,
  getTag,
  getTagGroup,
  postExists,
  removeTagFromPost,
  updateTagGroup,
} from '@pictoria/db'
import { getDb } from '../db.js'
import { OK, RESP_400, zodErrorHook } from '../openapi.js'
import { PostDetailPublic, toIsoDateTime } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

const MAX_TAG_LENGTH = 200

const Result = z.object({ msg: z.string() }).openapi('Result')

const TagGroupPublic = z
  .object({ id: z.int(), name: z.string(), color: z.string() })
  .openapi('TagGroupPublic')

// 键序 name → group → translatedName，照抄 baseline（注意和 TagWithGroupPublic
// 不同 —— 那个是 group 在前）。
const TagPublic = z
  .object({
    name: z.string(),
    group: z.union([TagGroupPublic, z.null()]).optional(),
    translatedName: z.string().nullable().optional(),
  })
  .openapi('TagPublic')

const TagCreate = z
  .object({ name: z.string().min(1).max(MAX_TAG_LENGTH), group_id: z.int().nullable().optional() })
  .openapi('TagCreate')

const TagUpdate = z.object({ group_id: z.int().nullable().optional() }).openapi('TagUpdate')

// 元素上**不加** maxLength —— baseline 里没有（msgspec 的 Meta 只作用在外层
// list 上，没有下推到元素）。加了 contract-diff 会报。
const TagBatchDelete = z
  .object({ name_list: z.array(z.string()).min(1) })
  .openapi('TagBatchDelete')

export const tagWritesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

/** 状态码照抄 `server/exceptions.py`：不同的领域错误声明了不同的码。 */
function domainError(detail: string, error: string, status: 404 | 409 | 422) {
  return new Response(JSON.stringify({ detail, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function camelTag(t: { is_auto: boolean, tag_info: Record<string, any> }) {
  const info = t.tag_info
  return {
    isAuto: t.is_auto,
    tagInfo: {
      group: info.group,
      name: info.name,
      translatedName: info.translated_name,
      updatedAt: toIsoDateTime(info.updated_at),
      createdAt: toIsoDateTime(info.created_at),
    },
  }
}

function toPostDetail(row: Record<string, any>) {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    extension: row.extension,
    fullPath: row.full_path,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspect_ratio,
    updatedAt: toIsoDateTime(row.updated_at),
    createdAt: toIsoDateTime(row.created_at),
    score: row.score,
    rating: row.rating,
    description: row.description,
    meta: row.meta,
    sha256: row.sha256,
    size: row.size,
    source: row.source,
    caption: row.caption,
    colors: row.colors,
    publishedAt: toIsoDateTime(row.published_at),
    dominantColor: row.dominant_color,
    arthash: row.arthash,
    canonicalPostId: row.canonical_post_id,
    groupMemberCount: row.group_member_count,
    waifuScore: row.waifu_score,
    aestheticScores: row.aesthetic_scores,
    tags: row.tags.map(camelTag),
  }
}

tagWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/tags',
    operationId: 'v2CreateTag',
    summary: 'CreateTag',
    description: 'Create a new tag, optionally associated with a tag group.',
    request: { body: { required: true, content: { 'application/json': { schema: TagCreate } } } },
    responses: {
      201: { description: 'Document created, URL follows', content: { 'application/json': { schema: Result } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    const name = data.name.trim()
    const { sqlite } = getDb()
    if (getTag(sqlite, name))
      return domainError(`Tag '${name}' already exists.`, 'TagNameExistsError', 409) as never
    if (data.group_id && !getTagGroup(sqlite, data.group_id))
      return domainError(`Tag group with ID ${data.group_id} does not exist.`, 'TagGroupNotFoundError', 422) as never
    createTag(sqlite, name, data.group_id ?? null)
    return c.json({ msg: `Tag '${name}' created successfully.` }, 201)
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/tags/{name}',
    operationId: 'v2UpdateTag',
    summary: 'UpdateTag',
    description: 'Reassign a tag to a different tag group.',
    request: {
      params: z.object({
        name: z.string().openapi({ param: { name: 'name', in: 'path', required: true } }),
      }),
      query: z.object({
        lang: z.string().default('zh-Hans')
          .openapi({ param: { name: 'lang', in: 'query', required: false } }),
      }),
      body: { required: true, content: { 'application/json': { schema: TagUpdate } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: TagPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { name } = c.req.valid('param')
    const { lang } = c.req.valid('query')
    const data = c.req.valid('json')
    const { sqlite } = getDb()
    if (!getTag(sqlite, name))
      return domainError(`Tag '${name}' does not exist.`, 'TagNameNotFoundError', 404) as never
    if (data.group_id && !getTagGroup(sqlite, data.group_id))
      return domainError(`Tag group with ID ${data.group_id} does not exist.`, 'TagGroupNotFoundError', 422) as never
    const updated = updateTagGroup(sqlite, name, data.group_id ?? null)
    if (!updated)
      return domainError(`Tag '${name}' does not exist.`, 'TagNameNotFoundError', 404) as never
    const group = updated.group_id ? getTagGroup(sqlite, updated.group_id) : undefined
    return c.json({
      name: updated.name,
      group: group ? { id: group.id, name: group.name, color: group.color } : null,
      translatedName: translateTag(updated.name, lang),
    })
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/v2/tags/{name}',
    operationId: 'v2DeleteTag',
    summary: 'DeleteTag',
    description: 'Delete a tag by name (also removes its post associations).',
    request: {
      params: z.object({
        name: z.string().openapi({ param: { name: 'name', in: 'path', required: true } }),
      }),
    },
    responses: { 204: { description: 'Request fulfilled, nothing follows' }, ...RESP_400 },
  }),
  (c) => {
    deleteTag(getDb().sqlite, c.req.valid('param').name)
    return c.body(null, 204) as never
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/v2/tags',
    operationId: 'v2DeleteTags',
    summary: 'DeleteTags',
    description: 'Delete multiple tags.',
    request: { body: { required: true, content: { 'application/json': { schema: TagBatchDelete } } } },
    responses: { 204: { description: 'Request fulfilled, nothing follows' }, ...RESP_400 },
  }),
  (c) => {
    deleteTags(getDb().sqlite, c.req.valid('json').name_list)
    return c.body(null, 204) as never
  },
)

/** post ↔ tag 关联：两个端点都在成功后回读整个详情。 */
const postTagParams = z.object({
  post_id: z.coerce.number().int()
    .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' }),
  tag_name: z.string().openapi({ param: { name: 'tag_name', in: 'path', required: true } }),
})

tagWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/posts/{post_id}/tags/{tag_name}',
    operationId: 'v2AddTagToPost',
    summary: 'AddTagToPost',
    request: { params: postTagParams },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const { sqlite } = getDb()
    if (!postExists(sqlite, postId))
      return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never
    if (!addTagToPost(sqlite, postId, tagName))
      return domainError(`Tag ${tagName} already exists in post ${postId}.`, 'TagAlreadyExistsError', 409) as never
    return c.json(toPostDetail(getDetail(sqlite, postId, n => translateTag(n))!)) as never
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/v2/posts/{post_id}/tags/{tag_name}',
    operationId: 'v2RemoveTagFromPost',
    summary: 'RemoveTagFromPost',
    request: { params: postTagParams },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...RESP_400,
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const { sqlite } = getDb()
    if (!postExists(sqlite, postId))
      return domainError(`Post with id ${postId} not found.`, 'PostNotFoundError', 404) as never
    if (!removeTagFromPost(sqlite, postId, tagName))
      return domainError(`Tag ${tagName} does not exist in post ${postId}.`, 'TagNotOnPostError', 409) as never
    return c.json(toPostDetail(getDetail(sqlite, postId, n => translateTag(n))!)) as never
  },
)
