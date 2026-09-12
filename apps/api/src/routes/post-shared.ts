/**
 * 多个路由文件共用的 post 相关小件。
 */
import type { Context } from 'hono'
import { z } from '@hono/zod-openapi'
import { getDetail } from '@pictoria/db'
import { getDb } from '../db.js'
import { postNotFound } from '../openapi.js'
import { toPostDetail } from '../schemas.js'
import { translateTag } from '../tag-i18n.js'

/** `{post_id}` 路径参数。`type` 覆盖是因为 coerce 会让 schema 变成 `number`。 */
export const postIdParam = z.coerce.number().int()
  .openapi({ param: { name: 'post_id', in: 'path', required: true }, type: 'integer' })

/**
 * 写完 / 算完之后回读整个详情 —— 命令端点和写端点成功时一律返回最新的
 * `PostDetailPublic`。行在写和读之间被删掉就是 404。
 */
export function postDetailResponse(c: Context<any, any, any>, postId: number, lang?: string) {
  const detail = getDetail(getDb().sqlite, postId, n => translateTag(n, lang))
  if (!detail)
    return postNotFound(postId)
  return c.json(toPostDetail(detail), 200)
}
