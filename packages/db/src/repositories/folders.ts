/**
 * 文件夹维度的聚合 —— 形状承自已退役的 Python 侧 `PostQueryService.folder_score_aggregates`。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { SILVA, SILVA_LUNA } from '../scorers.js'

/** 一个目录的直接汇总（不含子目录，由调用方沿树累加）。 */
export interface FolderScoreAgg {
  posts: number
  scored: number
  scoreTotal: number
  ratingTotal: number
  silvaTotal: number
  silvaN: number
  silvaLunaTotal: number
  silvaLunaN: number
}

export function emptyAgg(): FolderScoreAgg {
  return {
    posts: 0,
    scored: 0,
    scoreTotal: 0,
    ratingTotal: 0,
    silvaTotal: 0,
    silvaN: 0,
    silvaLunaTotal: 0,
    silvaLunaN: 0,
  }
}

export function addAgg(into: FolderScoreAgg, other: FolderScoreAgg): void {
  into.posts += other.posts
  into.scored += other.scored
  into.scoreTotal += other.scoreTotal
  into.ratingTotal += other.ratingTotal
  into.silvaTotal += other.silvaTotal
  into.silvaN += other.silvaN
  into.silvaLunaTotal += other.silvaLunaTotal
  into.silvaLunaN += other.silvaLunaN
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
    .prepare<[], {
      file_path: string
      posts: number
      scored: number
      score_total: number
      rating_total: number
      silva_total: number
      silva_n: number
      silva_luna_total: number
      silva_luna_n: number
    }>(
      `SELECT
         p.file_path                                          AS file_path,
         count(*)                                             AS posts,
         sum(CASE WHEN p.score > 0 THEN 1 ELSE 0 END)         AS scored,
         sum(CASE WHEN p.score > 0 THEN p.score ELSE 0 END)   AS score_total,
         sum(p.rating)                                        AS rating_total,
         sum(COALESCE(a.score, 0))                            AS silva_total,
         sum(CASE WHEN a.score IS NOT NULL THEN 1 ELSE 0 END) AS silva_n,
         sum(COALESCE(l.score, 0))                            AS silva_luna_total,
         sum(CASE WHEN l.score IS NOT NULL THEN 1 ELSE 0 END) AS silva_luna_n
       FROM posts p
       ${SILVA.joinSql({ alias: 'a' })}
       ${SILVA_LUNA.joinSql({ alias: 'l' })}
       GROUP BY p.file_path`,
    )
    .all()

  const out = new Map<string, FolderScoreAgg>()
  for (const r of rows) {
    out.set(r.file_path, {
      posts: Number(r.posts),
      scored: Number(r.scored),
      scoreTotal: Number(r.score_total),
      ratingTotal: Number(r.rating_total),
      silvaTotal: Number(r.silva_total),
      silvaN: Number(r.silva_n),
      silvaLunaTotal: Number(r.silva_luna_total),
      silvaLunaN: Number(r.silva_luna_n),
    })
  }
  return out
}
