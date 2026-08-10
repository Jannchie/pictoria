/**
 * 与 Litestar 契约对齐的 zod schema。
 *
 * 这一族继承 Python 的 `DTOBaseModel`（`alias_generator=to_camel`），所以对外是
 * **camelCase**；而 `PostFilter` 那一族是 msgspec Struct，对外是 snake_case。
 * 同一个请求里两种风格并存是正常的（见 §4.2），别顺手统一。
 *
 * 字段声明顺序照抄 baseline —— hey-api 按声明顺序生成 TS，顺序不同 diff 会红。
 */
import { z } from '@hono/zod-openapi'

export const TagGroupPublic = z
  .object({ id: z.int(), name: z.string(), color: z.string() })
  .openapi('TagGroupPublic')

export const TagWithGroupPublic = z
  .object({
    group: z.union([TagGroupPublic, z.null()]).optional(),
    name: z.string(),
    translatedName: z.string().nullable().optional(),
    updatedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .openapi('TagWithGroupPublic')

export const PostHasTagPublic = z
  .object({ isAuto: z.boolean(), tagInfo: TagWithGroupPublic })
  .openapi('PostHasTagPublic')

export const PostHasColorPublic = z
  .object({ order: z.int(), color: z.int() })
  .openapi('PostHasColorPublic')

/** Litestar 里所有"只回一句话"的命令端点共用的响应体。 */
export const Result = z.object({ msg: z.string() }).openapi('Result')

export const WaifuScorePublic = z.object({ score: z.number() }).openapi('WaifuScorePublic')

export const AestheticScorePublic = z
  .object({ scorer: z.string(), score: z.number() })
  .openapi('AestheticScorePublic')

export const PostDetailPublic = z
  .object({
    id: z.int(),
    filePath: z.string(),
    fileName: z.string(),
    extension: z.string(),
    fullPath: z.string(),
    width: z.int().nullable().optional(),
    height: z.int().nullable().optional(),
    aspectRatio: z.number().nullable().optional(),
    updatedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    score: z.int(),
    rating: z.int(),
    description: z.string(),
    meta: z.string(),
    sha256: z.string(),
    size: z.int(),
    source: z.string(),
    caption: z.string(),
    colors: z.array(PostHasColorPublic),
    publishedAt: z.iso.datetime().nullable().optional(),
    dominantColor: z.array(z.number()).nullable().optional(),
    arthash: z.string().nullable().optional(),
    canonicalPostId: z.int().nullable().optional(),
    groupMemberCount: z.int().default(0).optional(),
    waifuScore: z.union([WaifuScorePublic, z.null()]).optional(),
    aestheticScores: z.array(AestheticScorePublic).default([]).optional(),
    tags: z.array(PostHasTagPublic),
  })
  .openapi('PostDetailPublic')

export const PostSimplePublic = z
  .object({
    id: z.int(),
    filePath: z.string(),
    fileName: z.string(),
    extension: z.string(),
    rating: z.int(),
    score: z.int(),
    size: z.int(),
    width: z.int(),
    height: z.int(),
    aspectRatio: z.number().nullable().optional(),
    dominantColor: z.array(z.number()).nullable().optional(),
    arthash: z.string().nullable().optional(),
    colors: z.array(PostHasColorPublic),
    sha256: z.string(),
    canonicalPostId: z.int().nullable().optional(),
    groupMemberCount: z.int().default(0).optional(),
    matchProb: z.number().nullable().optional(),
    sortValue: z.union([z.number(), z.string(), z.null()]).optional(),
  })
  .openapi('PostSimplePublic')

/** DB 的 snake_case 行 → 对外的 camelCase DTO。 */
export function toCamel<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row))
    out[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v
  return out
}

/**
 * SQLite 存的是 `YYYY-MM-DD HH:MM:SS[.ffffff][±TZ]`，Pydantic 把 datetime 序列化成
 * ISO 8601（日期和时间之间是 `T`）。只换第一个空格 —— 时区偏移里没有空格，其余
 * 部分（含微秒）Pydantic 也是原样输出。
 */
export function toIsoDateTime<T>(v: T): T {
  if (typeof v !== 'string')
    return v
  return v.replace(' ', 'T') as unknown as T
}

/**
 * DB 行 → `PostSimplePublic`，键序照抄 DTO 声明顺序。
 *
 * `matchProb` / `sortValue` 只有搜索路径会填，但**必须出现在输出里**（Pydantic 会
 * 把未设置的可选字段序列化成 null），否则和 Litestar 的响应对不上。
 */
export function toPostSimple(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    extension: row.extension,
    rating: row.rating,
    score: row.score,
    size: row.size,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspect_ratio,
    dominantColor: row.dominant_color,
    arthash: row.arthash,
    colors: row.colors ?? [],
    sha256: row.sha256,
    canonicalPostId: row.canonical_post_id ?? null,
    groupMemberCount: row.group_member_count ?? 0,
    matchProb: row.match_prob ?? null,
    sortValue: row.sort_value ?? null,
  }
}
