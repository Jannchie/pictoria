/**
 * 跨多个路由文件共用的 zod schema。对外一律 **camelCase**。
 *
 * 字段声明顺序就是 JSON 里的键序，也是 hey-api 生成 TS 类型的顺序。
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

/** 所有"只回一句话"的命令端点共用的响应体。 */
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

/**
 * SQLite 存的是 `YYYY-MM-DD HH:MM:SS[.ffffff][±TZ]`，对外是 ISO 8601（日期和时间
 * 之间是 `T`）。只换第一个空格 —— 时区偏移里没有空格，其余部分（含微秒）原样。
 */
export function toIsoDateTime<T>(v: T): T {
  if (typeof v !== 'string')
    return v
  return v.replace(' ', 'T') as unknown as T
}

/**
 * DB 行 → `PostSimplePublic`。`matchProb` / `sortValue` 只有搜索路径会填，其余
 * 路径是 null。
 */
export type PostSimple = z.infer<typeof PostSimplePublic>

export function toPostSimple(row: Record<string, any>): PostSimple {
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

/** 键序照抄 PostDetailPublic 的声明顺序。 */
export function toPostDetail(row: Record<string, any>) {
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
