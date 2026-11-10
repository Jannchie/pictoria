/**
 * 统计信息的维护：`PRAGMA optimize`。
 *
 * 0022 迁移跑了一次全量 ANALYZE，planner 从此知道 `canonical_post_id IS NULL` 命中的是
 * 大半张表（靠 sqlite_stat4 的样本）。之后表的规模变了（新库从 0 涨到几十万、批量导入、
 * 大删除），`PRAGMA optimize` 只重新分析行数相对上次变化超过 10 倍的表，其余时候是
 * 毫秒级的空操作 —— 所以 `index.ts` 在启动时跑一次、之后每小时跑一次。
 *
 * ⚠️ 调用前钉 `analysis_limit = 0`。带 limit 的 ANALYZE 不写 stat4，还会删掉那张表已有的
 * stat4 行，首页计划随之退回 TEMP B-TREE（`packages/db/src/analyze.test.ts` 钉着这件事）。
 * 默认值本来就是 0；显式设一次，是不让别处设过的 limit 漏进来。
 *
 * 代价：真要重分析时是同步的全量 ANALYZE（真库副本上 posts 约 0.3 s，整库约 3 s），
 * 会占住事件循环。这只在表规模变了一个数量级时才发生。
 */
import type { SqliteHandle } from '@pictoria/db'

/**
 * `0x10002`：0x02 = 真去跑需要的 ANALYZE；0x10000 = 检查**所有**表，而不只是这条连接
 * 上查询用到过的表（刚起的连接还没跑过查询，不加它就什么都不做）。
 */
const OPTIMIZE_ALL_TABLES = 0x10002

export function optimizeDb(sqlite: SqliteHandle): void {
  sqlite.pragma('analysis_limit = 0')
  sqlite.pragma(`optimize = ${OPTIMIZE_ALL_TABLES}`)
}

/** 定时维护的间隔。一次 `optimize` 在没有变化时是空操作，一小时一次足够追上导入。 */
export const OPTIMIZE_INTERVAL_MS = 60 * 60 * 1000
