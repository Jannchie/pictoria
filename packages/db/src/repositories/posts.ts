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
