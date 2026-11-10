/**
 * tag 的写操作：独立 tag 的增删改，以及 post ↔ tag 的关联。
 *
 * 每个都有存在性校验：目标不存在是 404，引用的 group 不存在是 422（体是合法的，
 * 只是指向了不存在的东西），状态冲突（已存在 / 不在 post 上）是 409。
 */
import { createRoute, z } from '@hono/zod-openapi'
import {
  addTagToPost,
  addTagToPosts,
  createTag,
  deleteTag,
  deleteTags,
  getTag,
  getTagGroup,
  MAX_BULK_TAG_POSTS,
  missingPostIds,
  postExists,
  removeTagFromPost,
  removeTagFromPosts,
  setTagSource,
  updateTagGroup,
} from '@pictoria/db'
import { newRoutes } from '../env.js'
import { CREATED, OK, errors, fail, postNotFound } from '../openapi.js'
import { PostDetailPublic, Result, TagGroupPublic } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'
import { postDetailResponse, postIdParam } from './post-shared.js'

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

const PostTagSourceUpdate = z
  .object({ isAuto: z.boolean() })
  .openapi('PostTagSourceUpdate')

const PostTagAdd = z
  .object({
    isAuto: z.boolean().default(false)
      .openapi({ description: 'Write the row as auto (tagger-owned). Default false (human). Used to undo removing an auto tag.' }),
  })
  .openapi('PostTagAdd')

const BulkPostTagAdd = z
  .object({
    postIds: z.array(z.int()).min(1).max(MAX_BULK_TAG_POSTS),
    isAuto: z.boolean().default(false),
  })
  .openapi('BulkPostTagAdd')

const BulkPostTagRemove = z
  .object({ postIds: z.array(z.int()).min(1).max(MAX_BULK_TAG_POSTS) })
  .openapi('BulkPostTagRemove')

const BulkPostTagAddResult = z
  .object({
    added: z.array(z.int()).openapi({ description: 'Posts the tag was newly added to.' }),
    already: z.array(z.int()).openapi({ description: 'Posts that already had the tag (left untouched).' }),
  })
  .openapi('BulkPostTagAddResult')

const BulkPostTagRemoveResult = z
  .object({
    removed: z.array(z.int()).openapi({ description: 'Posts the tag was removed from.' }),
    absent: z.array(z.int()).openapi({ description: 'Posts that did not have the tag.' }),
  })
  .openapi('BulkPostTagRemoveResult')

const TagBatchDelete = z
  .object({ names: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).min(1) })
  .openapi('TagBatchDelete')

export const tagWritesRoutes = newRoutes()

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
    const sqlite = c.var.db
    if (getTag(sqlite, name))
      return fail(409, 'TagNameExistsError', `Tag '${name}' already exists.`)
    if (data.groupId && !getTagGroup(sqlite, data.groupId))
      return fail(422, 'TagGroupNotFoundError', `Tag group with ID ${data.groupId} does not exist.`)
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
    const sqlite = c.var.db
    if (!getTag(sqlite, name))
      return fail(404, 'TagNameNotFoundError', `Tag '${name}' does not exist.`)
    if (data.groupId && !getTagGroup(sqlite, data.groupId))
      return fail(422, 'TagGroupNotFoundError', `Tag group with ID ${data.groupId} does not exist.`)
    const updated = updateTagGroup(sqlite, name, data.groupId ?? null)
    if (!updated)
      return fail(404, 'TagNameNotFoundError', `Tag '${name}' does not exist.`)
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
    // FK 级联可能剥掉很多图的最后一个自动标签 —— `deleteTag` 自己发重新待办信号。
    deleteTag(c.var.db, c.req.valid('param').name)
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
    deleteTags(c.var.db, c.req.valid('json').names)
    return c.body(null, 204)
  },
)

/**
 * 批量 post ↔ tag：一批图加 / 摘同一个 tag，一个事务。
 *
 * ⚠️ **必须注册在 `/v2/posts/{post_id}/tags/{tag_name}` 之前** —— Hono 按注册顺序匹配，
 * 否则 `DELETE /v2/posts/bulk/tags/x` 会先命中 `{post_id}`，把 "bulk" coerce 成 NaN 报 400。
 *
 * 任何一个 id 不存在就整批 404、一行不写（与单张的 404 一致，而不是静默跳过）。
 */
const bulkTagParams = z.object({
  tag_name: z.string().min(1).max(MAX_TAG_LENGTH).openapi({ param: { name: 'tag_name', in: 'path', required: true } }),
})

function postsNotFound(ids: number[]) {
  const shown = ids.slice(0, 20).join(', ')
  return fail(404, 'PostNotFoundError', `Posts not found: ${shown}${ids.length > 20 ? ` (+${ids.length - 20} more)` : ''}.`)
}

tagWritesRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/posts/bulk/tags/{tag_name}',
    operationId: 'v2BulkAddTagToPosts',
    summary: 'BulkAddTagToPosts',
    description: `Add one tag to many posts in one transaction (creates the tag if needed). At most ${MAX_BULK_TAG_POSTS} posts.`,
    request: {
      params: bulkTagParams,
      body: { required: true, content: { 'application/json': { schema: BulkPostTagAdd } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: BulkPostTagAddResult } } },
      ...errors(400, 404),
    },
  }),
  (c) => {
    const { tag_name: tagName } = c.req.valid('param')
    const { postIds, isAuto } = c.req.valid('json')
    const sqlite = c.var.db
    const missing = missingPostIds(sqlite, postIds)
    if (missing.length)
      return postsNotFound(missing)
    return c.json(addTagToPosts(sqlite, postIds, tagName, isAuto), 200)
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/v2/posts/bulk/tags/{tag_name}',
    operationId: 'v2BulkRemoveTagFromPosts',
    summary: 'BulkRemoveTagFromPosts',
    description: `Remove one tag from many posts in one transaction. At most ${MAX_BULK_TAG_POSTS} posts.`,
    request: {
      params: bulkTagParams,
      body: { required: true, content: { 'application/json': { schema: BulkPostTagRemove } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: BulkPostTagRemoveResult } } },
      ...errors(400, 404),
    },
  }),
  (c) => {
    const { tag_name: tagName } = c.req.valid('param')
    const { postIds } = c.req.valid('json')
    const sqlite = c.var.db
    const missing = missingPostIds(sqlite, postIds)
    if (missing.length)
      return postsNotFound(missing)
    // 剥掉某些图最后一个自动标签时，`removeTagFromPosts` 自己发 tagger 重新待办信号。
    return c.json(removeTagFromPosts(sqlite, postIds, tagName), 200)
  },
)

/** post ↔ tag 关联：两个端点都在成功后回读整个详情。 */
const postTagParams = z.object({
  post_id: postIdParam,
  tag_name: z.string().openapi({ param: { name: 'tag_name', in: 'path', required: true } }),
})

tagWritesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/v2/posts/{post_id}/tags/{tag_name}',
    operationId: 'v2AddTagToPost',
    summary: 'AddTagToPost',
    description: 'Add a tag to a post (creates the tag if needed). Optional body `{isAuto}`; default is a human tag.',
    request: {
      params: postTagParams,
      body: { required: false, content: { 'application/json': { schema: PostTagAdd } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...errors(400, 404, 409),
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const sqlite = c.var.db
    if (!postExists(sqlite, postId))
      return postNotFound(postId)
    // 没带 body 时校验器给的是 `{}`，`isAuto` 的默认值不会被填上。
    const isAuto = c.req.valid('json').isAuto ?? false
    if (!addTagToPost(sqlite, postId, tagName, isAuto))
      return fail(409, 'TagAlreadyExistsError', `Tag ${tagName} already exists in post ${postId}.`)
    return postDetailResponse(c, postId)
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
    const sqlite = c.var.db
    if (!postExists(sqlite, postId))
      return postNotFound(postId)
    // 摘掉的若是这张图最后一个 `is_auto = 1` 行，它就重新是 tagger 待办了 ——
    // `removeTagFromPost` 自己发重新待办信号。
    if (!removeTagFromPost(sqlite, postId, tagName))
      return fail(409, 'TagNotOnPostError', `Tag ${tagName} does not exist in post ${postId}.`)
    return postDetailResponse(c, postId)
  },
)

tagWritesRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/v2/posts/{post_id}/tags/{tag_name}',
    operationId: 'v2SetPostTagSource',
    summary: 'SetPostTagSource',
    description: 'Mark a tag already on the post as human-confirmed (isAuto=false) or back to auto. Idempotent.',
    request: {
      params: postTagParams,
      body: { required: true, content: { 'application/json': { schema: PostTagSourceUpdate } } },
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: PostDetailPublic } } },
      ...errors(400, 404, 409),
    },
  }),
  (c) => {
    const { post_id: postId, tag_name: tagName } = c.req.valid('param')
    const { isAuto } = c.req.valid('json')
    const sqlite = c.var.db
    if (!postExists(sqlite, postId))
      return postNotFound(postId)
    // 确认掉的若是最后一个自动标签，`setTagSource` 自己发 tagger 重新待办信号。
    if (!setTagSource(sqlite, postId, tagName, isAuto))
      return fail(409, 'TagNotOnPostError', `Tag ${tagName} does not exist in post ${postId}.`)
    return postDetailResponse(c, postId)
  },
)
