/**
 * 导入器共用的两段式落库 —— 对应 Python 侧 `services/import_persist.py`。
 *
 * Danbooru 和 gallery-dl 落新 post 的方式是同一套：把每条源记录规整成
 * `NormalizedRow`，然后跑两个短事务 —— **先 tags，再 posts + post_has_tag**。
 *
 * 分成两个事务不是洁癖：并发导入插入重叠的 tag 时，`tags(name)` 的唯一性检查会在
 * 提交时把其中一个打回。让 tag 插入自己占一个短事务，重试面就只有那一小块，而不用
 * 把（大得多的）posts + post_has_tag 那一堆跟着重放一遍。
 *
 * ⚠️ 落库永远发生在**文件已经落盘之后**（见导入器的注释）：post 行绝不能早于它的
 * 文件存在，否则 sync 的对账会把它当成"文件已删除"，在下载还没跑完时就删掉它。
 * 这个模块处在那个顺序的下游 —— 它收到的行，字节都已经在磁盘上了。
 */
import type BetterSqlite3 from 'better-sqlite3'

export interface NormalizedRow {
  filePath: string
  fileName: string
  extension: string
  source: string
  rating: number
  publishedAt: string | null
  /** `{tag_name: group_id}`。 */
  tags: Record<string, number>
}

/**
 * 落 `rows` 和它们的 tag，返回 post id。
 *
 * `ON CONFLICT DO UPDATE` 那一支同样会触发 `RETURNING`，所以一条**已经存在但没有
 * tag** 的裸行（磁盘对账建出来的那种）也能拿到 id 并被补上 tag —— 这正是重跑一次
 * 导入能把它们补全的原因。
 */
export function persistPostsWithTags(
  sqlite: BetterSqlite3.Database,
  rows: NormalizedRow[],
): number[] {
  if (!rows.length)
    return []

  // 阶段 A：整批去重后的 tag upsert，自己一个短事务。
  const allTags = new Map<string, number>()
  for (const row of rows) {
    for (const [name, gid] of Object.entries(row.tags)) {
      if (!allTags.has(name))
        allTags.set(name, gid)
    }
  }
  if (allTags.size) {
    const insTag = sqlite.prepare(
      'INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
    )
    sqlite.transaction(() => {
      for (const [name, gid] of allTags) insTag.run(name, gid)
    })()
  }

  // 阶段 B：posts + post_has_tag。它们引用的 tag 已经被 A 提交了。
  const insPost = sqlite.prepare<unknown[], { id: number }>(
    'INSERT INTO posts(file_path, file_name, extension, source, rating, published_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (file_path, file_name, extension) '
    + 'DO UPDATE SET source = excluded.source, published_at = excluded.published_at, '
    + 'updated_at = CURRENT_TIMESTAMP '
    + 'RETURNING id',
  )
  const insLink = sqlite.prepare(
    'INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) ON CONFLICT DO NOTHING',
  )

  const ids: number[] = []
  sqlite.transaction(() => {
    for (const row of rows) {
      const got = insPost.get(
        row.filePath,
        row.fileName,
        row.extension,
        row.source,
        row.rating,
        row.publishedAt,
      )
      if (!got)
        continue
      ids.push(got.id)
      for (const name of Object.keys(row.tags)) insLink.run(got.id, name)
    }
  })()
  return ids
}

/**
 * 某个目录下**已经带 tag 导入过**的 Danbooru post id。
 *
 * id 从 `posts.file_name` 里来，因为对这个导入器来说那一列**就是** Danbooru 的
 * post id。去重过滤和翻页停止条件都拿原始 post id 和这个集合比，所以这个等价关系
 * 是承重的。
 *
 * ⚠️ 判据是"已经有一个手工（`is_auto = 0`）标签"，**不是**"post 行存在"。一个文件
 * 可能先以无标签的形式进库 —— 磁盘对账会给任何已在盘上的文件插一条裸行，而一次
 * DB 重置或快照回滚也会留下没有 `post_has_tag` 的文件。按"行存在"去重会让那些裸行
 * 永远被跳过（它们的 file_name 就在那儿），Danbooru 的标签永远写不进去。
 */
export function listImportedDanbooruIds(
  sqlite: BetterSqlite3.Database,
  filePathStr: string,
): string[] {
  return sqlite
    .prepare<[string], { file_name: string }>(
      'SELECT p.file_name FROM posts p '
      + 'JOIN post_has_tag pht ON pht.post_id = p.id AND pht.is_auto = 0 '
      + 'WHERE p.file_path = ?',
    )
    .all(filePathStr)
    .map(r => r.file_name)
}
