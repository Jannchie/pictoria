/**
 * `/v2/cmd/*` 里那些**针对单张图**的即时命令要用的读写。
 *
 * 和 `backfill.ts` 的区别不是规模而是语义：backfill 是"库里还差什么就补什么"，
 * 这里是"用户点了这一张，现在就给我结果"。所以它按 id 取单行、返回已存的分数
 * （命中就不重算），失败也不拉黑 —— 用户会再点一次，而黑名单会让第二次点击
 * 悄悄什么也不做。
 */
import type BetterSqlite3 from 'better-sqlite3'

/**
 * `is_image` 认的扩展名 —— 逐个照抄 `server/src/server/utils/__init__.py`。
 *
 * ⚠️ 比 `backfill.ts` 的 `IMAGE_EXTS` **宽**（多了 bmp/tiff/tif/svg），两者不能合并：
 * 那一个决定"backfill 要不要碰它"，这一个决定"端点返不返 400"。把 svg 塞进 backfill
 * 会让每一轮都去解码一个模型读不了的文件；而这里收窄则会让一张 bmp 从 400 变成
 * 一次真实计算 —— 都是可见的行为漂移。
 */
const IS_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg']

/** 路径看起来是不是一张图。等价于 Python 的 `is_image`（大小写不敏感的后缀判断）。 */
export function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return IS_IMAGE_EXTS.some(ext => lower.endsWith(`.${ext}`))
}

export interface CommandPost {
  id: number
  /** 相对 `target_dir` 的路径（`full_path` 生成列）。 */
  fullPath: string
}

/** 单张图的 id + 相对路径；不存在返回 `null`（端点据此给 404）。 */
export function getPostPath(
  sqlite: BetterSqlite3.Database,
  postId: number,
): CommandPost | null {
  const row = sqlite
    .prepare<[number], { id: number, full_path: string }>(
      'SELECT id, full_path FROM posts WHERE id = ?',
    )
    .get(postId)
  return row ? { id: row.id, fullPath: row.full_path } : null
}

/** 已存的 waifu 分，没有则 `null`。 */
export function getWaifuScore(sqlite: BetterSqlite3.Database, postId: number): number | null {
  const row = sqlite
    .prepare<[number], { score: number }>('SELECT score FROM post_waifu_scores WHERE post_id = ?')
    .get(postId)
  return row?.score ?? null
}

/** 已存的某个 scorer 的分，没有则 `null`。 */
export function getAestheticScore(
  sqlite: BetterSqlite3.Database,
  postId: number,
  scorer: string,
): number | null {
  const row = sqlite
    .prepare<[number, string], { score: number }>(
      'SELECT score FROM post_aesthetic_scores WHERE post_id = ? AND scorer = ?',
    )
    .get(postId, scorer)
  return row?.score ?? null
}

/**
 * 单张图的自动标签落库。
 *
 * ⚠️ 与 `persistTaggerResults` 有**一处刻意的不同**：rating 在这里**无条件**覆盖，
 * 而 backfill 那条只在原值为 0 时写。这不是疏忽 —— backfill 是后台自动跑的，不该
 * 推翻人工评级；而这个端点是用户主动点的"重新自动标注"，覆盖正是他要的。
 * Python 侧同样分成两条路径（`auto_tags` 直接 `update_field`，backfill 走
 * `_persist_wdtagger_results`），照抄。
 */
export function persistAutoTagsForPost(
  sqlite: BetterSqlite3.Database,
  row: { postId: number, generalTags: string[], characterTags: string[], rating: number },
  groups: Record<string, number>,
): void {
  const general = new Set(row.generalTags)
  const character = new Set(row.characterTags)
  const all = new Set([...general, ...character])

  const setRating = sqlite.prepare(
    'UPDATE posts SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  // 已有 group_id 的标签不被改组：手工归过组的不该被模型的猜测覆盖
  const upsertTag = sqlite.prepare(
    'INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE '
    + 'SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END',
  )
  const link = sqlite.prepare(
    'INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 1) '
    + 'ON CONFLICT (post_id, tag_name) DO NOTHING',
  )

  sqlite.transaction(() => {
    setRating.run(row.rating, row.postId)
    for (const name of general) upsertTag.run(name, groups.general)
    for (const name of character) upsertTag.run(name, groups.character)
    for (const name of all) link.run(row.postId, name)
  })()
}
