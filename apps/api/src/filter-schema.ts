/**
 * `PostFilter` 及其带排序的变体 —— 这两个 schema 被 10 个端点共用，所以定义放这里
 * 一份，而不是在每个路由文件里重抄。
 *
 * 全字段 snake_case：这一族在 Python 侧是 msgspec Struct，不走 to_camel（见 §4.2）。
 * 每个字段的 `description` 逐字抄自 baseline —— hey-api 把它转成 TS 上的 JSDoc，
 * 漏掉不影响类型，但编辑器里的悬停提示会空掉。
 */
import { z } from '@hono/zod-openapi'

const ORDER_COLUMNS = [
  'id', 'score', 'rating', 'created_at', 'published_at', 'file_name',
  'last_accessed_at', 'updated_at', 'waifu_score', 'silva_score',
  'silva_luna_score', 'discrepancy',
] as const

const baseFilter = {
  rating: z.array(z.int()).default([]).nullable().optional().describe("Rating filter."),
  score: z.array(z.int()).default([]).nullable().optional().describe("Score filter."),
  tags: z.array(z.string()).default([]).nullable().optional().describe("Tag filter."),
  extension: z.array(z.string()).default([]).nullable().optional().describe("Extension filter."),
  folder: z.string().nullable().optional(),
  lab: z.tuple([z.number(), z.number(), z.number()]).nullable().optional().describe("LAB color filter."),
  waifu_score_range: z.tuple([z.number(), z.number()]).nullable().optional().describe("Waifu score range filter."),
  waifu_score_levels: z.array(z.string()).default([]).nullable().optional().describe("Waifu-score bucket filter. Each value is one of 'A' (8-10), 'B' (6-8), 'C' (4-6), 'D' (2-4), 'E' (0-2), or 'UNSCORED' (no waifu score yet). Multiple values OR together."),
  silva_score_levels: z.array(z.string()).default([]).nullable().optional().describe("SILVA aesthetic bucket filter. Each value is one of 'A' (0.8-1.0), 'B' (0.6-0.8), 'C' (0.4-0.6), 'D' (0.2-0.4), 'E' (0-0.2), or 'UNSCORED' (no SILVA score yet). OR together."),
  silva_luna_score_levels: z.array(z.string()).default([]).nullable().optional().describe("SILVA-Luna aesthetic bucket filter. Same A-E edges over the [0, 1] domain as ``silva_score_levels`` (a second distilled judge, not a second tier), or 'UNSCORED'. OR together."),
  only_canonical: z.boolean().default(true).optional().describe("When true (default), hide near-duplicate group *members* and return only canonical (representative) posts — those with canonical_post_id NULL. Set false to include members."),
}

export const PostFilterSchema = z.object(baseFilter).openapi('PostFilter')

export const PostFilterWithOrderSchema = z
  .object({
    ...baseFilter,
    order_by: z.enum(ORDER_COLUMNS).nullable().optional().describe("Order column."),
    order: z.enum(['asc', 'desc', 'random']).default('desc').optional().describe("Order direction."),
    order_seed: z.int().nullable().optional().describe("Seed for ``order='random'``. The same seed yields a stable shuffle, so offset pagination stays consistent across pages; a fresh seed reshuffles. Ignored unless ``order='random'``."),
    sort_direction: z.enum(['asc', 'desc']).nullable().optional().describe("Sort direction for ``order_by`` when ``order='random'``. Ignored unless both ``order='random'`` and ``order_by`` are set."),
  })
  .openapi('PostFilterWithOrder')

/** `PostFilter` 加上 tag 计数专用的三个字段。键序照抄 baseline：过滤器在前。 */
export const TagCountRequestSchema = z
  .object({
    ...baseFilter,
    query: z.string().default('').optional().describe("Substring filter on tag names."),
    limit: z.int().default(50).optional().describe("Max tags returned, by descending count."),
    lang: z.string().default('zh-Hans').optional().describe("Locale for translated tag names (e.g. zh-Hans; en yields null)."),
  })
  .openapi('TagCountRequest')

/** `PostFilter` 加一个自然语言查询串。 */
export const TextSearchRequestSchema = z
  .object({
    ...baseFilter,
    query: z.string().default('').optional().describe("Natural-language search prompt."),
  })
  .openapi('TextSearchRequest')
