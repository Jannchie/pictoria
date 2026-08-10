/**
 * post 详情读模型 —— 对应 Python 侧 `PostQueryService.get_detail` 及其批量取。
 *
 * 每个关联（tags / colors / waifu / aesthetic）都是**一次**批量 SQL，再在内存里
 * 缝起来。逐条 N+1 在 22 万行的库上会直接把列表页拖垮。
 */
import type BetterSqlite3 from 'better-sqlite3'

/** `PostDetailPublic` 的列集合，与 Python 侧 `db/entities.POST_COLUMNS` 逐字一致。 */
export const POST_COLUMNS
  = 'id, file_path, file_name, extension, full_path, width, height, '
    + 'aspect_ratio, published_at, score, rating, description, meta, '
    + 'sha256, size, source, caption, dominant_color, arthash, '
    + 'canonical_post_id, created_at, updated_at'

/** `PostSimplePublic` 的基础列（search 路径带 `p.` 前缀用同一份）。 */
export const SIMPLE_BASE_COLUMNS = [
  'id',
  'file_path',
  'file_name',
  'extension',
  'rating',
  'score',
  'size',
  'width',
  'height',
  'aspect_ratio',
  'dominant_color',
  'arthash',
  'sha256',
] as const

export const SIMPLE_POST_COLUMNS = [...SIMPLE_BASE_COLUMNS, 'canonical_post_id'].join(', ')

export interface TagInfo {
  name: string
  translated_name: string | null
  created_at: string
  updated_at: string
  group: { id: number, name: string, color: string } | null
}

export interface PostTag {
  is_auto: boolean
  tag_info: TagInfo
}

export interface PostColor {
  order: number
  color: number
}

export interface AestheticScore {
  scorer: string
  score: number
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/** 解码 sqlite-vec 的 FLOAT[3] BLOB。 */
export function decodeDominantColor(v: unknown): number[] | null {
  if (v === null || v === undefined)
    return null
  if (v instanceof Uint8Array) {
    const n = Math.floor(v.length / 4)
    if (n === 0)
      return null
    const f = new Float32Array(v.buffer, v.byteOffset, n)
    return Array.from(f)
  }
  if (Array.isArray(v))
    return v as number[]
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as number[]
    }
    catch {
      return null
    }
  }
  return null
}

/**
 * 每个 post 的 tag，按 canonical 分组顺序再按名字排。
 *
 * 分组顺序是写死的 artist → copyright → character → general → meta → 其它，
 * 与 Python 侧的 CASE 逐字一致 —— 前端直接依赖这个顺序渲染。
 */
export function fetchTagsByIds(
  sqlite: BetterSqlite3.Database,
  ids: number[],
  translate: (name: string) => string | null,
): Map<number, PostTag[]> {
  const out = new Map<number, PostTag[]>()
  if (!ids.length)
    return out

  const rows = sqlite
    .prepare<unknown[], {
      post_id: number
      is_auto: number
      name: string
      created_at: string
      updated_at: string
      group_id: number | null
      group_name: string | null
      group_color: string | null
    }>(
      `SELECT pht.post_id AS post_id,
              pht.is_auto AS is_auto,
              t.name AS name,
              t.created_at AS created_at,
              t.updated_at AS updated_at,
              tg.id AS group_id,
              tg.name AS group_name,
              tg.color AS group_color
       FROM post_has_tag pht
       JOIN tags t ON t.name = pht.tag_name
       LEFT JOIN tag_groups tg ON tg.id = t.group_id
       WHERE pht.post_id IN (${placeholders(ids.length)})
       ORDER BY pht.post_id,
           CASE COALESCE(tg.name, '')
               WHEN 'artist'    THEN 0
               WHEN 'copyright' THEN 1
               WHEN 'character' THEN 2
               WHEN 'general'   THEN 3
               WHEN 'meta'      THEN 4
               ELSE 5
           END,
           t.name`,
    )
    .all(...ids)

  for (const r of rows) {
    const list = out.get(r.post_id) ?? []
    list.push({
      is_auto: Boolean(r.is_auto),
      tag_info: {
        name: r.name,
        translated_name: translate(r.name),
        created_at: r.created_at,
        updated_at: r.updated_at,
        group: r.group_id === null
          ? null
          : { id: r.group_id, name: r.group_name!, color: r.group_color! },
      },
    })
    out.set(r.post_id, list)
  }
  return out
}

export function fetchColorsByIds(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, PostColor[]> {
  const out = new Map<number, PostColor[]>()
  if (!ids.length)
    return out
  const rows = sqlite
    .prepare<unknown[], { post_id: number, order: number, color: number }>(
      `SELECT post_id, "order", color FROM post_has_color `
      + `WHERE post_id IN (${placeholders(ids.length)}) ORDER BY post_id, "order"`,
    )
    .all(...ids)
  for (const r of rows) {
    const list = out.get(r.post_id) ?? []
    list.push({ order: r.order, color: r.color })
    out.set(r.post_id, list)
  }
  return out
}

export function fetchWaifuByIds(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, { score: number }> {
  const out = new Map<number, { score: number }>()
  if (!ids.length)
    return out
  for (const r of sqlite
    .prepare<unknown[], { post_id: number, score: number }>(
      `SELECT post_id, score FROM post_waifu_scores WHERE post_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids))
    out.set(r.post_id, { score: r.score })
  return out
}

export function fetchAestheticByIds(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, AestheticScore[]> {
  const out = new Map<number, AestheticScore[]>()
  if (!ids.length)
    return out
  const rows = sqlite
    .prepare<unknown[], { post_id: number, scorer: string, score: number }>(
      `SELECT post_id, scorer, score FROM post_aesthetic_scores `
      + `WHERE post_id IN (${placeholders(ids.length)}) ORDER BY post_id, scorer`,
    )
    .all(...ids)
  for (const r of rows) {
    const list = out.get(r.post_id) ?? []
    list.push({ scorer: r.scorer, score: r.score })
    out.set(r.post_id, list)
  }
  return out
}

/**
 * 每个 canonical post 名下藏着几个成员：`{canonical_id: n}`。
 *
 * 只有真的做了 canonical 的 post（即有别的 post 的 canonical_post_id 指向它）才有
 * 条目；没分组的 post 不出现（视作 0）。
 */
export function memberCounts(
  sqlite: BetterSqlite3.Database,
  canonicalIds: number[],
): Map<number, number> {
  const out = new Map<number, number>()
  if (!canonicalIds.length)
    return out
  const rows = sqlite
    .prepare<unknown[], { canonical_post_id: number, n: number }>(
      `SELECT canonical_post_id, count(*) AS n FROM posts `
      + `WHERE canonical_post_id IN (${placeholders(canonicalIds.length)}) GROUP BY canonical_post_id`,
    )
    .all(...canonicalIds)
  for (const r of rows) out.set(r.canonical_post_id, Number(r.n))
  return out
}

export interface PostDetail extends Record<string, unknown> {
  id: number
  tags: PostTag[]
  colors: PostColor[]
  waifu_score: { score: number } | null
  aesthetic_scores: AestheticScore[]
  group_member_count: number
}

/**
 * 详情读模型：post 列 + join 上来的 tags / colors / scores。
 *
 * post 不存在时返回 `null`。`translate` 挑 tag 的 `translated_name` 表
 * （`en` 会返回 null → 前端回退到原始名）。
 */
export function getDetail(
  sqlite: BetterSqlite3.Database,
  postId: number,
  translate: (name: string) => string | null,
): PostDetail | null {
  const post = sqlite
    .prepare<[number], Record<string, unknown>>(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`)
    .get(postId)
  if (!post)
    return null

  post.dominant_color = decodeDominantColor(post.dominant_color)
  const ids = [postId]
  return {
    ...post,
    id: postId,
    tags: fetchTagsByIds(sqlite, ids, translate).get(postId) ?? [],
    colors: fetchColorsByIds(sqlite, ids).get(postId) ?? [],
    waifu_score: fetchWaifuByIds(sqlite, ids).get(postId) ?? null,
    aesthetic_scores: fetchAestheticByIds(sqlite, ids).get(postId) ?? [],
    group_member_count: memberCounts(sqlite, ids).get(postId) ?? 0,
  } as PostDetail
}

/**
 * `canonical_id` 组里被隐藏的成员，最早的在前。
 *
 * 详情页的"同组"横条用它把主列表里藏起来的其它分辨率/近重复揭出来。post 没有
 * 成员时返回 `[]`。
 */
export function getGroupMembers(
  sqlite: BetterSqlite3.Database,
  canonicalId: number,
): Array<Record<string, unknown>> {
  const rows = sqlite
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${SIMPLE_POST_COLUMNS} FROM posts WHERE canonical_post_id = ? ORDER BY id ASC`,
    )
    .all(canonicalId)

  const ids = rows.map(r => r.id as number)
  const colors = fetchColorsByIds(sqlite, ids)
  for (const r of rows) {
    r.dominant_color = decodeDominantColor(r.dominant_color)
    r.colors = colors.get(r.id as number) ?? []
    r.group_member_count = 0
  }
  return rows
}
