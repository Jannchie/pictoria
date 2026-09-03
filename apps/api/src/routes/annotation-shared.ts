/**
 * `/v2/annotations` 与 `/v2/annotation-queues` 共用的定义。
 *
 * 这两个 router 都被 `index.ts` 挂进同一个 app，所以 `.openapi(name)` 注册的是
 * **同一个** 组件表。`QueueItemPostPublic` 曾在两边各定义一遍：字段今天一致所以
 * 无感，但注册表里只会留下后注册的那一份 —— 哪天只给其中一份加字段，
 * `/schema/openapi.json` 会静默取另一份，`pnpm genapi` 生成的类型对一半端点就是
 * 错的，而且没有任何东西会报错。组件名是全局的，定义就必须是全局的。
 */
import { z } from '@hono/zod-openapi'

export const QueueItemPostPublic = z
  .object({
    id: z.int(),
    filePath: z.string(),
    fileName: z.string(),
    extension: z.string(),
    sha256: z.string(),
    width: z.int(),
    height: z.int(),
  })
  .openapi('QueueItemPostPublic')

/**
 * 带前缀的图片列 → `QueueItemPostPublic`。
 *
 * `prefix` 是给一行里带两张图的查询用的（pairwise 的 `a_` / `b_`）；不带前缀的
 * 调用方正好是 `prefix = ''`，所以这一个函数覆盖两种形状。
 */
export function toQueuePost(row: Record<string, any>, prefix = '') {
  return {
    id: row[`${prefix}post_id`],
    filePath: row[`${prefix}file_path`],
    fileName: row[`${prefix}file_name`],
    extension: row[`${prefix}extension`],
    sha256: row[`${prefix}sha256`],
    width: row[`${prefix}width`],
    height: row[`${prefix}height`],
  }
}

/** 与 Python 侧 `annotations.py` / `annotation_queues.py` 的常量一致。 */
export const VALID_DIMENSIONS = ['color', 'finish', 'composition', 'overall'] as const
export const VALID_STRATEGIES = ['random', 'stratified'] as const
export const VALID_PAIRWISE_STRATEGIES = ['random', 'similar', 'close'] as const
