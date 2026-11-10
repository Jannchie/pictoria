/**
 * 选哪个 tag 来驱动查询（`buildWhere` 的 `drivingTag`）。
 *
 * planner 自己选不对：rowid 上的 `IN (子查询)` 它无条件拿来驱动，相关 EXISTS 它永远从
 * posts 驱动；改写成 JOIN 让它按代价选也不行 —— `post_has_tag` 有 2400 万行，stat4 只
 * 采 24 个样本，`tag_name = ?` 的行数估计对绝大多数 tag 都是平均值（~216），10 万图的
 * 热门 tag 照样被当成冷门的从 tag 侧驱动（真库实测 101–250 ms，EXISTS 0.3 ms）。
 * 而准确的基数就躺在 `tags.post_count` 上（触发器维护），一次主键点查。
 *
 * 阈值来自真库（37.5 万 posts）ANALYZE 之后的副本：
 *
 *   列表（ORDER BY 索引列 LIMIT 100）    post_count   EXISTS      IN
 *                                            500     64–334 ms   1–2 ms
 *                                           2500     14–31 ms    6–15 ms
 *                                           5000      6–16 ms    8–27 ms
 *                                          20000     1–3 ms     28–100 ms
 *                                         101062     0.3 ms     60–216 ms
 *
 *   计数（全量 count，无 LIMIT）              2292     111 ms      3 ms
 *                                         101062     119 ms      87 ms
 *                                         281172     118 ms     187 ms
 *
 * 列表有 LIMIT，EXISTS 沿排序索引凑满 100 条就停，tag 越热停得越早；IN 要把这个 tag 的
 * 全部 post 取出来再排序。计数没有 LIMIT，两边都得走完，IN 只在 tag 占到全库大半时才输。
 */
import type BetterSqlite3 from 'better-sqlite3'

/** 列表查询：tag 的 post 数不超过它才用 IN 驱动（交叉点在 2500–5000 之间）。 */
export const LIST_DRIVE_MAX_POSTS = 3000

/** 计数 / facet 查询：不超过它就用 IN 驱动（交叉点在 10 万–28 万之间）。 */
export const COUNT_DRIVE_MAX_POSTS = 150_000

/**
 * `tags` 里 post 数最少的那个 tag —— 不超过 `maxPostCount` 才返回，否则 `null`
 * （全用 EXISTS）。`tags` 表里没有的名字按 0 算：它什么都匹配不上，用它驱动立刻结束。
 */
export function pickDrivingTag(
  sqlite: BetterSqlite3.Database,
  tags: readonly string[] | null | undefined,
  maxPostCount: number,
): string | null {
  if (!tags?.length)
    return null
  const count = sqlite.prepare<[string], number>('SELECT post_count FROM tags WHERE name = ?').pluck()
  let best: string | null = null
  let bestCount = Infinity
  for (const tag of tags) {
    const n = count.get(tag) ?? 0
    if (n < bestCount) {
      best = tag
      bestCount = n
    }
  }
  return bestCount <= maxPostCount ? best : null
}
