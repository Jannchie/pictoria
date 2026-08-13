/**
 * tags / tag_groups 的读取 —— 对应 Python 侧 `db/repositories/tags.py`。
 */
import { placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'

export interface TagGroupRow {
  id: number
  name: string
  color: string
}

export interface TagWithCount {
  name: string
  group: TagGroupRow | null
  count: number
}

/**
 * `[{name, group, count}, ...]`，按 tag 名游标分页。
 *
 * `count` 读的是触发器维护的 `tags.post_count`（migration 0008），而不是对 940 万行的
 * `post_has_tag` 做 GROUP BY（那样每次约 630 ms）。这个反规范化计数**只覆盖 canonical
 * post** —— 近重复分组里被隐藏的成员不计（migration 0009），与 tag 过滤 facet 的语义一致。
 */
export function listTagsWithCounts(
  sqlite: BetterSqlite3.Database,
  { prev, limit }: { prev?: string | null, limit?: number | null } = {},
): TagWithCount[] {
  let sql
    = 'SELECT t.name AS name, t.group_id AS group_id, '
      + 'tg.id AS g_id, tg.name AS g_name, tg.color AS g_color, '
      + 't.post_count AS count '
      + 'FROM tags t '
      + 'LEFT JOIN tag_groups tg ON tg.id = t.group_id '
  const params: unknown[] = []
  if (prev) {
    sql += 'WHERE t.name > ? '
    params.push(prev)
  }
  sql += 'ORDER BY t.name '
  if (limit) {
    sql += 'LIMIT ?'
    params.push(limit)
  }

  const rows = sqlite
    .prepare<unknown[], {
      name: string
      group_id: number | null
      g_id: number | null
      g_name: string | null
      g_color: string | null
      count: number
    }>(sql)
    .all(...params)

  return rows.map(r => ({
    name: r.name,
    group: r.g_id === null ? null : { id: r.g_id, name: r.g_name!, color: r.g_color! },
    count: r.count,
  }))
}

export function listTagGroups(sqlite: BetterSqlite3.Database): TagGroupRow[] {
  return sqlite
    .prepare<[], TagGroupRow>('SELECT id, name, color FROM tag_groups ORDER BY id')
    .all()
}

/** tag 行（`tags` 表本身）。 */
export interface TagRow {
  name: string
  group_id: number | null
  created_at: string
  updated_at: string
}

export function getTag(sqlite: BetterSqlite3.Database, name: string): TagRow | undefined {
  return sqlite
    .prepare<[string], TagRow>('SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?')
    .get(name)
}

export function getTagGroup(sqlite: BetterSqlite3.Database, id: number): TagGroupRow | undefined {
  return sqlite
    .prepare<[number], TagGroupRow>('SELECT id, name, color FROM tag_groups WHERE id = ?')
    .get(id)
}

export function createTag(
  sqlite: BetterSqlite3.Database,
  name: string,
  groupId: number | null,
): TagRow {
  sqlite
    .prepare('INSERT INTO tags(name, group_id) VALUES(?, ?) ON CONFLICT(name) DO NOTHING')
    .run(name, groupId)
  const tag = getTag(sqlite, name)
  if (!tag)
    throw new Error(`Tag insert failed for: ${name}`)
  return tag
}

export function updateTagGroup(
  sqlite: BetterSqlite3.Database,
  name: string,
  groupId: number | null,
): TagRow | undefined {
  sqlite
    .prepare('UPDATE tags SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?')
    .run(groupId, name)
  return getTag(sqlite, name)
}

/** `post_has_tag.tag_name` 对 `tags.name` 有 ON DELETE CASCADE，join 行自动跟着删。 */
export function deleteTag(sqlite: BetterSqlite3.Database, name: string): void {
  sqlite.prepare('DELETE FROM tags WHERE name = ?').run(name)
}

export function deleteTags(sqlite: BetterSqlite3.Database, names: string[]): void {
  if (!names.length)
    return
  const ph = placeholders(names.length)
  sqlite.prepare(`DELETE FROM tags WHERE name IN (${ph})`).run(...names)
}

/**
 * 给 post 打 tag，插入成功返回 true，本来就有返回 false。
 *
 * 两条语句而不是三条：tags 表的插入是幂等的（`ON CONFLICT DO NOTHING`），关联表
 * 的插入用 `RETURNING` —— 冲突路径不会 RETURNING，于是"有没有取到行"就是存在信号。
 */
export function addTagToPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
  tagName: string,
): boolean {
  sqlite.prepare('INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING').run(tagName)
  const row = sqlite
    .prepare(
      'INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES(?, ?, 0) ON CONFLICT DO NOTHING RETURNING post_id',
    )
    .get(postId, tagName)
  return row !== undefined
}

/** 摘掉 post 上的 tag，删掉了返回 true，本来就没有返回 false。 */
export function removeTagFromPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
  tagName: string,
): boolean {
  const row = sqlite
    .prepare('DELETE FROM post_has_tag WHERE post_id = ? AND tag_name = ? RETURNING post_id')
    .get(postId, tagName)
  return row !== undefined
}
