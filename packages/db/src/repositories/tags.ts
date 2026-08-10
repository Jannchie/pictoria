/**
 * tags / tag_groups 的读取 —— 对应 Python 侧 `db/repositories/tags.py`。
 */
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
