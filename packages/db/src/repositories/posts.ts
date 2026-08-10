/**
 * posts 表的写操作 —— 对应 Python 侧 `db/repositories/posts.py`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { BULK_UPDATABLE_FIELDS, UPDATABLE_FIELDS } from '../filters.js'

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

const UPDATE_SQL = (field: string, whereSql: string) =>
  `UPDATE posts SET ${field} = ?, updated_at = CURRENT_TIMESTAMP, `
  + `last_accessed_at = CURRENT_TIMESTAMP WHERE ${whereSql}`

/**
 * 更新一个白名单标量列，匹配到行返回 `true`。
 *
 * 需要新状态的调用方自己再查一次（例如 `getDetail`）—— 这样这里不必多做一次
 * SELECT。`field` 会被拼进 SQL，白名单是唯一的注入防线。
 */
export function updateField(
  sqlite: BetterSqlite3.Database,
  postId: number,
  field: string,
  value: unknown,
): boolean {
  if (!UPDATABLE_FIELDS.has(field))
    throw new Error(`Field is not whitelisted for update: ${field}`)

  const stmt = sqlite.prepare(UPDATE_SQL(field, 'id = ?'))
  if (field !== 'score')
    return stmt.run(value, postId).changes > 0

  // 给 canonical post 打分会把分数镜像到它近重复组里的**每一个**成员，让整组
  // 始终共享代表的分数（成员是被隐藏的重复图）。这会覆盖成员单独得到的分数，
  // 0 分同样会清空整组。放在一个事务里 —— 两条 UPDATE 之间被打断，会让组和
  // 代表分叉。
  const mirror = sqlite.prepare(
    'UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP WHERE canonical_post_id = ?',
  )
  let matched = false
  sqlite.transaction(() => {
    matched = stmt.run(value, postId).changes > 0
    mirror.run(value, postId)
  })()
  return matched
}

/** 批量更新一个白名单列。score 同样镜像到各组成员（理由同上）。 */
export function bulkUpdateField(
  sqlite: BetterSqlite3.Database,
  ids: number[],
  field: string,
  value: unknown,
): void {
  if (!BULK_UPDATABLE_FIELDS.has(field))
    throw new Error(`Field is not whitelisted for bulk update: ${field}`)
  if (!ids.length)
    return

  const stmt = sqlite.prepare(UPDATE_SQL(field, `id IN (${placeholders(ids.length)})`))
  if (field !== 'score') {
    stmt.run(value, ...ids)
    return
  }

  const mirror = sqlite.prepare(
    `UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP `
    + `WHERE canonical_post_id IN (${placeholders(ids.length)})`,
  )
  sqlite.transaction(() => {
    stmt.run(value, ...ids)
    mirror.run(value, ...ids)
  })()
}

/**
 * 给 Recently 视图更新 `last_accessed_at`，行存在返回 `true`。
 *
 * **不动 `updated_at`** —— 看一眼不算编辑。
 */
export function touchAccessed(sqlite: BetterSqlite3.Database, postId: number): boolean {
  return (
    sqlite
      .prepare('UPDATE posts SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(postId).changes > 0
  )
}

/** post 是否存在。 */
export function postExists(sqlite: BetterSqlite3.Database, postId: number): boolean {
  return sqlite.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId) !== undefined
}

/** 解组：把这些 id 提回独立的 canonical post。 */
export function clearCanonical(sqlite: BetterSqlite3.Database, ids: number[]): void {
  if (!ids.length)
    return
  sqlite
    .prepare(
      `UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP `
      + `WHERE id IN (${placeholders(ids.length)})`,
    )
    .run(...ids)
}

/**
 * 把 `postId` 提升为它所在组的 canonical（"设为封面"）。
 *
 * 把原 canonical 和所有兄弟成员重新指向 `postId`，再清掉 `postId` 自己的指针。
 * post 不存在或本来就是 canonical 时是空操作（返回 false）。
 *
 * 一个事务：两条 UPDATE 之间，这个组是个 2-环 —— **每个**成员（含原 canonical）
 * 的指针都非 NULL，也就是整组从列表里消失。被打断不能把那个状态冻住，WAL 读者
 * 也绝不能观察到它。
 */
export function makeCanonical(sqlite: BetterSqlite3.Database, postId: number): boolean {
  const row = sqlite
    .prepare<[number], { canonical_post_id: number | null }>(
      'SELECT canonical_post_id FROM posts WHERE id = ?',
    )
    .get(postId)
  if (!row || row.canonical_post_id === null)
    return false
  const current = row.canonical_post_id

  const repoint = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE (id = ? OR canonical_post_id = ?) AND id != ?',
  )
  const promote = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  sqlite.transaction(() => {
    repoint.run(postId, current, current, postId)
    promote.run(postId)
  })()
  return true
}

/**
 * 删除 post 及其全部从属行，返回被删掉的相对文件路径。
 *
 * `ON DELETE CASCADE`（0001_initial.sql 里声明的）负责 `post_has_color` /
 * `post_waifu_scores`。`post_vectors_siglip2` 是 vec0 虚表，不参与外键级联，
 * 必须显式清。`post_has_tag` 也显式删、而且**排在 posts 行前面** —— 这样
 * canonical 感知的 `tags.post_count` 触发器（migration 0009）看到的是每个 post
 * 真实的 canonical 状态，而不是和外键级联抢跑。
 *
 * 分块，于是调用方可以传任意多个 id 而不撞上 SQLite 的绑定参数上限；每块的三条
 * DELETE 在一个事务里，被中断也不会留下一个活着但被剥了标签和向量的 post。
 *
 * 文件不在这里删 —— 返回路径由调用方处理，因为 target_dir 是 API 层的知识。
 */
export function deleteManyReturningPaths(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): string[] {
  if (!ids.length)
    return []
  const CHUNK = 500
  const fullPaths: string[] = []

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const ph = placeholders(chunk.length)
    sqlite.transaction(() => {
      // 删行之前先把文件路径收集起来
      for (const row of sqlite
        .prepare<unknown[], { full_path: string }>(`SELECT full_path FROM posts WHERE id IN (${ph})`)
        .all(...chunk))
        fullPaths.push(row.full_path)
      // 显式且排在 posts 之前，好让 trg_post_has_tag_count_ad 在 post 行还在时触发
      sqlite.prepare(`DELETE FROM post_has_tag WHERE post_id IN (${ph})`).run(...chunk)
      // vec0 虚表 —— 没有外键级联
      sqlite.prepare(`DELETE FROM post_vectors_siglip2 WHERE post_id IN (${ph})`).run(...chunk)
      sqlite.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...chunk)
    })()
  }
  return fullPaths
}

/**
 * 直接存在 `folder` 或其任意子目录下的 post id。
 *
 * 精确前缀语义（`folder` 或 `folder/...`）：范围比较恰好抓住以 `folder/` 开头的
 * 路径（'0' 是 '/' 的下一个码位），永远不会捎上只是共享名字前缀的兄弟目录
 * （`art` vs `art2`），而且 —— 不像 GLOB —— 对目录名里的 `[ ] * ?` 免疫。
 */
export function listIdsInFolder(sqlite: BetterSqlite3.Database, folder: string): number[] {
  return sqlite
    .prepare<[string, string, string], { id: number }>(
      'SELECT id FROM posts WHERE file_path = ? OR (file_path >= ? AND file_path < ?) ORDER BY id',
    )
    .all(folder, `${folder}/`, `${folder}0`)
    .map(r => r.id)
}

/** 旋转之后要一起改的那几列。 */
export function updateForRotate(
  sqlite: BetterSqlite3.Database,
  postId: number,
  v: { sha256: string, size: number, width: number, height: number, arthash: string | null },
): void {
  sqlite
    .prepare(
      'UPDATE posts SET sha256 = ?, size = ?, width = ?, height = ?, arthash = ?, '
      + 'updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .run(v.sha256, v.size, v.width, v.height, v.arthash, postId)
}
