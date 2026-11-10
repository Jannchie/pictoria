/**
 * tags / tag_groups 的读取 —— 形状承自已退役的 Python 侧 `db/repositories/tags.py`。
 */
import { placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { notifyRepending } from '../repending.js'

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

/**
 * `post_has_tag.tag_name` 对 `tags.name` 有 ON DELETE CASCADE，join 行自动跟着删。
 *
 * 级联可能剥掉很多图的最后一个自动标签 —— 那些图重新变成 tagger 待办，而它们的 id 都在
 * 待办查询的水位线**以下**，不喊的话会静默地永远不被重新打标（见 `../repending.ts`）。
 */
export function deleteTag(sqlite: BetterSqlite3.Database, name: string): void {
  deleteTags(sqlite, [name])
}

export function deleteTags(sqlite: BetterSqlite3.Database, names: string[]): void {
  if (!names.length)
    return
  const ph = placeholders(names.length)
  // 删之前问一句"有没有图因此丢掉最后一个自动标签"：只删手工标签的话 tagger 待办不变，
  // 不该逼它全库重扫（真实库上一次是 1.8 秒的同步阻塞）。删完再问就问不到了 —— 级联
  // 已经把关联行带走。
  // 取被剥光的图里最小的 id：水位线只需退到那里（见 `../repending.ts`）。
  const firstStranded = sqlite
    .prepare<unknown[], number | null>(
      `SELECT MIN(pht.post_id) FROM post_has_tag pht WHERE pht.tag_name IN (${ph}) AND pht.is_auto = 1 `
      + `AND NOT EXISTS (SELECT 1 FROM post_has_tag o WHERE o.post_id = pht.post_id AND o.is_auto = 1 `
      + `AND o.tag_name NOT IN (${ph}))`,
    )
    .pluck()
    .get(...names, ...names)
  sqlite.prepare(`DELETE FROM tags WHERE name IN (${ph})`).run(...names)
  if (firstStranded != null)
    notifyRepending(sqlite, 'tagger', firstStranded)
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

/**
 * 摘掉 post 上的 tag，删掉了返回 true，本来就没有返回 false。
 *
 * 摘掉的若是这张图最后一个 `is_auto = 1` 行，它就重新是 tagger 待办了，而它的 id 在
 * 水位线以下 —— 这里喊一声（见 `../repending.ts`）。摘手工标签不改变 tagger 待办，不喊。
 */
export function removeTagFromPost(
  sqlite: BetterSqlite3.Database,
  postId: number,
  tagName: string,
): boolean {
  const row = sqlite
    .prepare<[number, string], { is_auto: number }>(
      'DELETE FROM post_has_tag WHERE post_id = ? AND tag_name = ? RETURNING is_auto',
    )
    .get(postId, tagName)
  if (row === undefined)
    return false
  if (row.is_auto === 1)
    notifyIfAutoTagsGone(sqlite, postId)
  return true
}

/**
 * 把 post 上一个已有的 tag 改成人工确认（`isAuto = false`）或改回自动，返回 tag 在不在
 * post 上。状态本来就是目标值时什么也不写，同样返回 true（幂等）。
 *
 * 确认过的标签不再是 tagger 的：重新打标 / 换模型只清 `is_auto = 1` 的行，它会留下来。
 * 代价和摘标签一样 —— 确认掉的若是这张图最后一个自动标签，它就重新是 tagger 待办，
 * 这里同样喊一声（见 `../repending.ts`）。
 */
export function setTagSource(
  sqlite: BetterSqlite3.Database,
  postId: number,
  tagName: string,
  isAuto: boolean,
): boolean {
  const changed = sqlite
    .prepare<[number, number, string, number], { post_id: number }>(
      'UPDATE post_has_tag SET is_auto = ? WHERE post_id = ? AND tag_name = ? AND is_auto <> ? RETURNING post_id',
    )
    .get(isAuto ? 1 : 0, postId, tagName, isAuto ? 1 : 0)
  if (changed === undefined) {
    return sqlite
      .prepare<[number, string], number>('SELECT 1 FROM post_has_tag WHERE post_id = ? AND tag_name = ?')
      .pluck()
      .get(postId, tagName) !== undefined
  }
  if (!isAuto)
    notifyIfAutoTagsGone(sqlite, postId)
  return true
}

/** 这张图刚失去一行 `is_auto = 1`：若那是最后一行，它重新是 tagger 待办。 */
function notifyIfAutoTagsGone(sqlite: BetterSqlite3.Database, postId: number): void {
  const anyLeft = sqlite
    .prepare<[number], number>('SELECT 1 FROM post_has_tag WHERE post_id = ? AND is_auto = 1 LIMIT 1')
    .pluck()
    .get(postId)
  if (anyLeft === undefined)
    notifyRepending(sqlite, 'tagger', postId)
}
