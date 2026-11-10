/**
 * `tags.post_count` 的对账：和 `post_has_tag` 重新数一遍，只改对不上的行。
 *
 * 这个计数由触发器维护（migration 0008 / 0009），只数 canonical（可见）post。触发器
 * 本身没有漏洞，但它有一个**前提**：删 post 时 `post_has_tag` 要在 posts 行之前显式
 * 删掉（`deleteManyReturningPaths` 这样做）。只 `DELETE FROM posts`、让外键级联去删
 * 关联行的话，`trg_post_has_tag_count_ad` 触发时 post 行已经没了，WHEN 里的子查询
 * 读到 NULL，把一个**隐藏成员**当成 canonical 减了一次 —— 计数偏少。真库上那几个
 * 偏少 5–6 的热门 tag 来自 2026-06 已删除的 `server/scripts/clean_truncated_images.py`
 * （它恰好是这样删的 411 张图）。见 `tag-post-count.test.ts`。
 *
 * 不在启动路径上：整库 GROUP BY 在 2400 万行的 `post_has_tag` 上是十几秒。入口是
 * `apps/api/src/scripts/recount-tags.ts`。
 */
import type BetterSqlite3 from 'better-sqlite3'

export interface TagCountDrift {
  name: string
  /** `tags.post_count` 里存的。 */
  stored: number
  /** 按 canonical post 实数出来的。 */
  actual: number
}

/** 对不上的 tag，偏差绝对值大的在前。只读。 */
export function tagPostCountDrift(sqlite: BetterSqlite3.Database): TagCountDrift[] {
  return sqlite
    .prepare<[], TagCountDrift>(
      `WITH actual AS (
         SELECT pht.tag_name, count(*) AS c
         FROM post_has_tag pht JOIN posts p ON p.id = pht.post_id
         WHERE p.canonical_post_id IS NULL
         GROUP BY pht.tag_name
       )
       SELECT t.name, t.post_count AS stored, coalesce(a.c, 0) AS actual
       FROM tags t LEFT JOIN actual a ON a.tag_name = t.name
       WHERE t.post_count <> coalesce(a.c, 0)
       ORDER BY abs(t.post_count - coalesce(a.c, 0)) DESC, t.name`,
    )
    .all()
}

/**
 * 把对不上的 `post_count` 改成实数，返回改了哪些。
 *
 * 两段：整库扫描（十几秒）在事务**外**找出可疑的 tag；然后在一个 IMMEDIATE 事务里对
 * 这几个 tag 逐个重数（走 `ix_post_has_tag_tag_name`，毫秒级）再写。写锁只占后一段，
 * 而写进去的是锁内数出来的值 —— 扫描之后挤进来的写入不会让它过期。只改漂移的那几行，
 * 不整表重写：整表 UPDATE 会把 5 万行都标脏、让读缓存无谓失效。
 */
export function recountTagPostCounts(sqlite: BetterSqlite3.Database): TagCountDrift[] {
  const suspects = tagPostCountDrift(sqlite)
  const get = sqlite.prepare<[string], { stored: number, actual: number }>(
    `SELECT t.post_count AS stored,
            (SELECT count(*) FROM post_has_tag pht JOIN posts p ON p.id = pht.post_id
             WHERE pht.tag_name = t.name AND p.canonical_post_id IS NULL) AS actual
     FROM tags t WHERE t.name = ?`,
  )
  const set = sqlite.prepare('UPDATE tags SET post_count = ? WHERE name = ?')
  return sqlite.transaction(() => {
    const fixed: TagCountDrift[] = []
    for (const { name } of suspects) {
      const row = get.get(name)
      if (!row || row.stored === row.actual)
        continue
      set.run(row.actual, name)
      fixed.push({ name, stored: row.stored, actual: row.actual })
    }
    return fixed
  }).immediate()
}
