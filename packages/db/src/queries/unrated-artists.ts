/**
 * 「未评分画师」快捷入口：每个从没被人工打过星的画师挑一张代表图。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { placeholders } from '../sql.js'
import { SILVA } from '../scorers.js'

/**
 * 不代表任何具体画师的占位 artist 标签 —— 给它们打分没有意义，永远不进列表。
 */
export const PLACEHOLDER_ARTIST_TAGS = [
  'anonymous_artist',
  'unknown_artist',
  'banned_artist',
  'artist_request',
  'third-party_edit',
] as const

/**
 * 未评分画师的代表图 id，按代表图的 SILVA 分从高到低（无分垫底），同分按 id 升序。
 *
 * 「未评分画师」= `artist` 组里 `post_count > 0`、且没有任何一张带它的图 `score > 0`
 * 的标签（排除占位标签）。代表图 = 带这个标签的图里 SILVA 分最高的那张。一张图同时
 * 带两个未评分画师时只出现一次。
 *
 * ⚠️ 两段各自的连接顺序都是钉死的，别"简化"：
 * - `tag_groups g CROSS JOIN tags t`：先用组名定位到 artist 组，再走 `ix_tags_group_id`。
 *   放任 planner 的话它会从 `ix_tags_post_count` 扫**所有**有图的标签、对每个都跑一遍
 *   NOT EXISTS，最后才判组名（真库 3 s vs 0.8 s）。
 * - `unrated AS MATERIALIZED`：写成普通 CTE 时 planner 会把两段揉在一起重排，真库 8.6 s；
 *   物化后第二段只是对 2.3 万个名字各走一次 `ix_post_has_tag_tag_name`。
 * 真库（17 万图、2.3 万未评分画师）整条约 1.3 s。
 */
export function unratedArtistPickIds(sqlite: BetterSqlite3.Database): number[] {
  const silva = SILVA.name
  return sqlite
    .prepare<unknown[], number>(
      `WITH unrated AS MATERIALIZED (
         SELECT t.name
         FROM tag_groups g CROSS JOIN tags t ON t.group_id = g.id
         WHERE g.name = 'artist'
           AND t.post_count > 0
           AND t.name NOT IN (${placeholders(PLACEHOLDER_ARTIST_TAGS.length)})
           AND NOT EXISTS (
             SELECT 1 FROM post_has_tag pht CROSS JOIN posts p ON p.id = pht.post_id
             WHERE pht.tag_name = t.name AND p.score > 0
           )
       ),
       picks AS MATERIALIZED (
         SELECT (
           SELECT pht.post_id
           FROM post_has_tag pht
           LEFT JOIN post_aesthetic_scores s ON s.post_id = pht.post_id AND s.scorer = ?
           WHERE pht.tag_name = u.name
           ORDER BY s.score DESC NULLS LAST, pht.post_id
           LIMIT 1
         ) AS post_id
         FROM unrated u
       )
       SELECT k.post_id
       FROM (SELECT DISTINCT post_id FROM picks WHERE post_id IS NOT NULL) k
       LEFT JOIN post_aesthetic_scores s ON s.post_id = k.post_id AND s.scorer = ?
       ORDER BY s.score DESC NULLS LAST, k.post_id`,
    )
    .pluck()
    .all(...PLACEHOLDER_ARTIST_TAGS, silva, silva)
}
