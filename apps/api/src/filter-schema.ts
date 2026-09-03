/**
 * `PostFilter` 及其带排序的变体 —— 这两个 schema 被 10 个端点共用，所以定义放这里
 * 一份，而不是在每个路由文件里重抄。
 *
 * 全字段 snake_case：这一族在 Python 侧是 msgspec Struct，不走 to_camel（见 §4.2）。
 * 每个字段的 `description` 逐字抄自 baseline —— hey-api 把它转成 TS 上的 JSDoc，
 * 漏掉不影响类型，但编辑器里的悬停提示会空掉。
 */
import type { FilterableScorerName } from '@pictoria/db'
import { z } from '@hono/zod-openapi'
import { FILTERABLE_SCORERS, levelsField, ORDERABLE_COLUMNS } from '@pictoria/db'

// 排序列此前在这里逐字重抄了一遍，而 `@pictoria/db` 早就导出了同一份
// `ORDERABLE_COLUMNS`。抄的那份漂了不会有任何报错：`post-search.ts` 认的是 db 那份，
// 于是多出来的列走到 `sortable = false`，`ORDER BY` 整个消失，返回任意序 —— 而
// offset 分页在任意序上翻页会重复和漏掉行。
// 插入序即枚举取值序，它在 OpenAPI 契约里，别重排。
const ORDER_COLUMNS = [...ORDERABLE_COLUMNS] as [string, ...string[]]

/**
 * 分档过滤字段的说明文案，一个打分器一条。
 *
 * 这是 `Record<FilterableScorerName, string>` 而不是可选表：加一个打分器时
 * TypeScript 会**强制**你在这里补一条，否则编译不过。文案没法从模板生成 —— 三条
 * 的结构本来就不一样（silva_luna 那条是引用 silva 那条来说明的），所以它们作为
 * 数据存在这里，而不是被拼出来。
 */
const LEVELS_DESCRIPTIONS: Record<FilterableScorerName, string> = {
  waifu: "Waifu-score bucket filter. Each value is one of 'A' (8-10), 'B' (6-8), 'C' (4-6), 'D' (2-4), 'E' (0-2), or 'UNSCORED' (no waifu score yet). Multiple values OR together.",
  silva: "SILVA aesthetic bucket filter. Each value is one of 'A' (0.8-1.0), 'B' (0.6-0.8), 'C' (0.4-0.6), 'D' (0.2-0.4), 'E' (0-0.2), or 'UNSCORED' (no SILVA score yet). OR together.",
  silva_luna: "SILVA-Luna aesthetic bucket filter. Same A-E edges over the [0, 1] domain as ``silva_score_levels`` (a second distilled judge, not a second tier), or 'UNSCORED'. OR together.",
}

/** 每个打分器一个 `<name>_score_levels` 字段，顺序与注册表一致。 */
const levelsFields = Object.fromEntries(
  FILTERABLE_SCORERS.map(spec => [
    levelsField(spec),
    z.array(z.string()).default([]).nullable().optional().describe(LEVELS_DESCRIPTIONS[spec.name]),
  ]),
)

const baseFilter = {
  rating: z.array(z.int()).default([]).nullable().optional().describe("Rating filter."),
  score: z.array(z.int()).default([]).nullable().optional().describe("Score filter."),
  tags: z.array(z.string()).default([]).nullable().optional().describe("Tag filter."),
  extension: z.array(z.string()).default([]).nullable().optional().describe("Extension filter."),
  folder: z.string().nullable().optional(),
  lab: z.tuple([z.number(), z.number(), z.number()]).nullable().optional().describe("LAB color filter."),
  waifu_score_range: z.tuple([z.number(), z.number()]).nullable().optional().describe("Waifu score range filter."),
  ...levelsFields,
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
