/**
 * tag 的写操作：独立 tag 的增删改，以及 post ↔ tag 的关联。
 *
 * 每个都有存在性校验：目标不存在是 404，引用的 group 不存在是 422（体是合法的，
 * 只是指向了不存在的东西），状态冲突（已存在 / 不在 post 上）是 409。
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
import { CREATED, OK, errors, fail, postNotFound, zodErrorHook } from '../openapi.js'
import { wakeAllBackfills } from '../scheduler.js'
import { PostDetailPublic, Result, TagGroupPublic, toPostDetail } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

const MAX_TAG_LENGTH = 200

const TagPublic = z
  .object({
    name: z.string(),
    group: z.union([TagGroupPublic, z.null()]).optional(),
    translatedName: z.string().nullable().optional(),
  })
  .openapi('TagPublic')

const TagCreate = z
  .object({ name: z.string().min(1).max(MAX_TAG_LENGTH), groupId: z.int().nullable().optional() })
  .openapi('TagCreate')

const TagUpdate = z.object({ groupId: z.int().nullable().optional() }).openapi('TagUpdate')

const TagBatchDelete = z
  .object({ names: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).min(1) })
  .openapi('TagBatchDelete')

export const tagWritesRoutes = new OpenAPIHono({ defaultHook: zodErrorHook })

tagWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/tags',
    operationId: 'v2CreateTag',
    summary: 'CreateTag',
    description: 'Create a new tag, optionally associated with a tag group.',
    request: { body: { required: true, content: { 'application/json': { schema: TagCreate } } } },
    responses: {
      201: { description: CREATED, content: { 'application/json': { schema: Result } } },
      ...errors(400, 409, 422),
    },
  }),
  (c) => {
    const data = c.req.valid('json')
    const name = data.name.trim()
    const { sqlite } = getDb()
    if (getTag(sqlite, name))
      return fail(c, 409, 'TagNameExistsError', `Tag '${name}' already exists.`)
    if (data.groupId && !getTagGroup(sqlite, data.groupId))
      return fail(c, 422, 'TagGroupNotFoundError', `Tag group with ID ${data.groupId} does not exist.`)
    createTag(sqlite, name, data.groupId ?? null)
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
      ...errors(400, 404, 422),
    },
  }),
  (c) => {
    const { name } = c.req.valid('param')
    const { lang } = c.req.valid('query')
    const data = c.req.valid('json')
    const { sqlite } = getDb()
    if (!getTag(sqlite, name))
      return fail(c, 404, 'TagNameNotFoundError', `Tag '${name}' does not exist.`)
    if (data.groupId && !getTagGroup(sqlite, data.groupId))
      return fail(c, 422, 'TagGroupNotFoundError', `Tag group with ID ${data.groupId} does not exist.`)
    const updated = updateTagGroup(sqlite, name, data.groupId ?? null)
    if (!updated)
      return fail(c, 404, 'TagNameNotFoundError', `Tag '${name}' does not exist.`)
    const group = updated.group_id ? getTagGroup(sqlite, updated.group_id) : undefined
    return c.json({
      name: updated.name,
      group: group ? { id: group.id, name: group.name, color: group.color } : null,
      translatedName: translateTag(updated.name, lang),
    }, 200)
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
    responses: { 204: { description: 'No Content' }, ...errors(400) },
  }),
  (c) => {
    deleteTag(getDb().sqlite, c.req.valid('param').name)
    // `post_has_tag` 走 FK 级联，这一下可能剥掉很多图的最后一个自动标签 —— 那些图
    // 重新变成 tagger 待办，而它们的 id 都在待办查询的水位线**以下**，不叫醒的话
    // 会静默地永远不被重新打标。
    wakeAllBackfills()
    return c.body(null, 204)
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
    responses: { 204: { description: 'No Content' }, ...errors(400) },
  }),
  (c) => {
    deleteTags(getDb().sqlite, c.req.valid('json').names)
    wakeAllBackfills()
    return c.body(null, 204)
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
      ...errors(400, 404, 409),
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const { sqlite } = getDb()
    if (!postExists(sqlite, postId))
      return postNotFound(c, postId)
    if (!addTagToPost(sqlite, postId, tagName))
      return fail(c, 409, 'TagAlreadyExistsError', `Tag ${tagName} already exists in post ${postId}.`)
    return c.json(toPostDetail(getDetail(sqlite, postId, n => translateTag(n))!), 200)
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
      ...errors(400, 404, 409),
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const { sqlite } = getDb()
    if (!postExists(sqlite, postId))
      return postNotFound(c, postId)
    if (!removeTagFromPost(sqlite, postId, tagName))
      return fail(c, 409, 'TagNotOnPostError', `Tag ${tagName} does not exist in post ${postId}.`)
    // 摘掉的若是这张图最后一个 `is_auto = 1` 行，它就重新是 tagger 待办了。
    wakeAllBackfills()
    return c.json(toPostDetail(getDetail(sqlite, postId, n => translateTag(n))!), 200)
  },
)
