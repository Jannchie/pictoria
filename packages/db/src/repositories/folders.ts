/**
 * 文件夹维度的聚合 —— 形状承自已退役的 Python 侧 `PostQueryService.folder_score_aggregates`。
 *
 * 每个打分器的聚合列与 LEFT JOIN 由 `SCORERS` 生成，加一个打分器不用动这里。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { type AestheticScorerName, SCORERS } from '../scorers.js'

/** 一个打分器在一个目录里的分数之和与已打分条数。 */
export interface ScorerAgg {
  total: number
  n: number
}

/** 一个目录的直接汇总（不含子目录，由调用方沿树累加）。 */
export interface FolderScoreAgg {
  posts: number
  scored: number
  scoreTotal: number
  ratingTotal: number
  /** 键是 `SCORERS` 的 `name`。 */
  scorers: Record<AestheticScorerName, ScorerAgg>
}

function emptyScorerAggs(): Record<AestheticScorerName, ScorerAgg> {
  return Object.fromEntries(SCORERS.map(s => [s.name, { total: 0, n: 0 }])) as Record<AestheticScorerName, ScorerAgg>
}

export function emptyAgg(): FolderScoreAgg {
  return { posts: 0, scored: 0, scoreTotal: 0, ratingTotal: 0, scorers: emptyScorerAggs() }
}

export function addAgg(into: FolderScoreAgg, other: FolderScoreAgg): void {
  into.posts += other.posts
  into.scored += other.scored
  into.scoreTotal += other.scoreTotal
  into.ratingTotal += other.ratingTotal
  for (const { name } of SCORERS) {
    into.scorers[name].total += other.scorers[name].total
    into.scorers[name].n += other.scorers[name].n
  }
}

/**
 * `folderScoreAggregates` 的 SQL。导出只为了让测试把它钉在改写前的手写版本上。
 *
 * ⚠️ 形状别动：一次扫 `posts`、每个打分器一条 `LEFT JOIN`（走
 * `post_aesthetic_scores` 的 (post_id, scorer) 主键）、一次 GROUP BY。拆成两趟实测
 * 更慢（见 `apps/api/src/routes/folders.ts` 的 `walk` 注释与 docs/optimization-audit.md B1）。
 */
export function folderScoreAggregatesSql(): string {
  const cols = SCORERS.flatMap(s => [
    `sum(COALESCE(${s.scoreCol()}, 0)) AS ${s.name}_total`,
    `sum(CASE WHEN ${s.scoreCol()} IS NOT NULL THEN 1 ELSE 0 END) AS ${s.name}_n`,
  ])
  return [
    'SELECT',
    [
      'p.file_path AS file_path',
      'count(*) AS posts',
      'sum(CASE WHEN p.score > 0 THEN 1 ELSE 0 END) AS scored',
      'sum(CASE WHEN p.score > 0 THEN p.score ELSE 0 END) AS score_total',
      'sum(p.rating) AS rating_total',
      ...cols,
    ].join(',\n'),
    'FROM posts p',
    ...SCORERS.map(s => s.joinSql()),
    'GROUP BY p.file_path',
  ].join('\n')
}

/**
 * 一次 GROUP BY 把每个 `file_path` 目录的分数汇总出来。
 *
 * 键是 `posts.file_path`（post 所在目录，如 `danbooru/wlop`；根目录的 post 是 `.`）。
 * `scoreTotal` / `scored` **只统计已评分的 post**（score > 0），免得没评分的 0 分把
 * 人工均分拉低；覆盖率单独用比值报告。
 */
export function folderScoreAggregates(
  sqlite: BetterSqlite3.Database,
): Map<string, FolderScoreAgg> {
  const rows = sqlite
    .prepare<[], { file_path: string } & Record<string, unknown>>(folderScoreAggregatesSql())
    .all()

  const out = new Map<string, FolderScoreAgg>()
  for (const r of rows) {
    const scorers = emptyScorerAggs()
    for (const { name } of SCORERS) {
      scorers[name].total = Number(r[`${name}_total`])
      scorers[name].n = Number(r[`${name}_n`])
    }
    out.set(r.file_path, {
      posts: Number(r.posts),
      scored: Number(r.scored),
      scoreTotal: Number(r.score_total),
      ratingTotal: Number(r.rating_total),
      scorers,
    })
  }
  return out
}
