/**
 * Backfill 的**数据**一侧：待办查询与结果落库。
 *
 * 计算不在这里，也不会在这里 —— 它在 Python worker 里，通过 cairnq 往返
 * （见 `docs/refactor-monorepo-hono.md` §D1）。这个文件是那条原则里"所有数据库
 * 写入在 TS"的那一半：待办查询挑出要算什么，结果函数把算完的东西写回去。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE } from '../scorers.js'
import { SIGLIP2_TABLE } from './vectors.js'

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/** 一个 worker 的失败黑名单键，例如 `aesthetic:silva`。与 Python 侧同拼法。 */
export function aestheticWorkerKey(scorer: string): string {
  return `aesthetic:${scorer}`
}

/**
 * 排除某个 worker 桶下被拉黑的 post。带一个 `?`，调用方追加 worker 键。
 *
 * 迁移期间这张表还在：Python 侧的 backfill 仍在写它，两边的待办查询必须看到
 * 同一批候选，否则一个跳过的东西另一个会一直重算。cairnq 的重试语义最终会
 * 取代它（§D2），但那要等 Phase 6 把最后一个 worker 搬完。
 */
export function notFailedClause(alias = 'p'): string {
  return `NOT EXISTS (SELECT 1 FROM post_process_failures f WHERE f.post_id = ${alias}.id AND f.worker = ?)`
}

/**
 * 有 SigLIP2 向量、但还没有 `scorer` 分数的 post id，按 id 升序。
 *
 * "有没有向量"用一次 vec0 的 post_id 列全扫做集合求交，而不是每行一个
 * `EXISTS` —— vec0 的点查是虚表探测不是 B-tree 探测，逐行探在库规模上要几十秒。
 * 候选顺序（p.id 升序）在过滤后保持不变。
 */
export function listSilvaPending(
  sqlite: BetterSqlite3.Database,
  scorer: string,
  limit?: number,
): number[] {
  const candidates = sqlite
    .prepare<[string, string], { id: number }>(
      `SELECT p.id FROM posts p `
      + `WHERE NOT EXISTS (SELECT 1 FROM ${AESTHETIC_SCORES_TABLE} pas WHERE pas.post_id = p.id AND pas.scorer = ?) `
      + `AND ${notFailedClause('p')} `
      + `ORDER BY p.id`,
    )
    .all(scorer, aestheticWorkerKey(scorer))
    .map(r => r.id)

  const embedded = new Set(
    sqlite.prepare<[], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE}`).all().map(r => r.post_id),
  )
  const pending = candidates.filter(pid => embedded.has(pid))
  return limit === undefined ? pending : pending.slice(0, limit)
}

/**
 * `post_id -> embedding blob`，原样取出不做数值转换。
 *
 * 交给 cairnq payload 的就是这段字节的 base64（见 `@pictoria/contracts` 的
 * codec）—— 从库里读出来到 worker 手上，中间没有任何一步把它变成十进制。
 */
export function fetchEmbeddingBlobs(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  if (!ids.length)
    return out
  for (const row of sqlite
    .prepare<unknown[], { post_id: number, embedding: Buffer }>(
      `SELECT post_id, embedding FROM ${SIGLIP2_TABLE} WHERE post_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids))
    out.set(row.post_id, row.embedding)
  return out
}

/**
 * 批量写入某个 scorer 的分数。一个事务里的多条 upsert。
 *
 * 这是 worker 算完之后唯一的落库点。Python 侧一行都不写 —— 它甚至不持有到这个
 * 库的连接。
 */
export function upsertAestheticScores(
  sqlite: BetterSqlite3.Database,
  scorer: string,
  rows: Array<{ postId: number, score: number }>,
): void {
  if (!rows.length)
    return
  const stmt = sqlite.prepare(
    `INSERT INTO ${AESTHETIC_SCORES_TABLE}(post_id, scorer, score) VALUES (?, ?, ?) `
    + `ON CONFLICT (post_id, scorer) DO UPDATE SET score = excluded.score`,
  )
  sqlite.transaction(() => {
    for (const r of rows) stmt.run(r.postId, scorer, r.score)
  })()
}

/**
 * worker 会处理的图片扩展名。与 Python 侧 `processors/common.py` 的 `IMAGE_EXTS` 同集合。
 *
 * 待办查询就带上它，而不是等批处理器逐张过滤 —— 后者会让 `.txt` / `.zip` 白占一个
 * 批次的名额。
 */
const IMAGE_EXTS = ['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'] as const
const IMAGE_EXT_WHERE = `LOWER(p.extension) IN (${IMAGE_EXTS.map(e => `'${e}'`).join(', ')})`

/** `post_process_failures.worker` 里 waifu 用的桶名。与 Python 侧同值。 */
const WAIFU_WORKER = 'waifu'

/** 待办的图片：post id 加上磁盘上的绝对路径。 */
export interface PendingImage {
  postId: number
  path: string
}

/**
 * 还没有 waifu 分、且没被拉黑的图片，按 id 升序。
 *
 * 绝对路径在 SQL 里就拼好（`full_path` 是生成列），省掉一趟"查 id 再查行"。
 * `targetDir` 必须是绝对路径 —— worker 那边会把它当根来校验路径没有逃逸。
 */
export function listWaifuPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
): PendingImage[] {
  const sql
    = `SELECT p.id, p.full_path FROM posts p `
      + `LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id `
      + `WHERE pws.post_id IS NULL AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = limit === undefined ? [WAIFU_WORKER] : [WAIFU_WORKER, limit]
  const rows = sqlite.prepare<unknown[], { id: number, full_path: string }>(sql).all(...params)

  return rows.map(r => ({ postId: r.id, path: `${targetDir}/${r.full_path}` }))
}

/** 批量写入 waifu 分数。一个事务里的多条 upsert。 */
export function upsertWaifuScores(
  sqlite: BetterSqlite3.Database,
  rows: Array<{ postId: number, score: number }>,
): void {
  if (!rows.length)
    return
  const stmt = sqlite.prepare(
    'INSERT INTO post_waifu_scores(post_id, score) VALUES (?, ?) '
    + 'ON CONFLICT (post_id) DO UPDATE SET score = excluded.score',
  )
  sqlite.transaction(() => {
    for (const r of rows) stmt.run(r.postId, r.score)
  })()
}

/**
 * 把 `(post, worker)` 一次性拉黑。
 *
 * `INSERT OR IGNORE`，于是重复记录同一条失败是空操作而不是唯一约束错误 ——
 * 有人手工删掉黑名单行让它重试、结果又失败一次时就会走到这里。
 */
export function recordFailures(
  sqlite: BetterSqlite3.Database,
  worker: string,
  rows: Array<{ postId: number, error: string }>,
): void {
  if (!rows.length)
    return
  const stmt = sqlite.prepare(
    'INSERT OR IGNORE INTO post_process_failures (post_id, worker, error) VALUES (?, ?, ?)',
  )
  sqlite.transaction(() => {
    for (const r of rows) stmt.run(r.postId, worker, r.error)
  })()
}

// ─── tagger ───────────────────────────────────────────────────────────

/** `post_process_failures.worker` 里 tagger 用的桶名。 */
const TAGGER_WORKER = 'tagger'

/**
 * 四个规范 tag 组及其颜色。与 Python 侧 `services/wd_tagging.py` 的
 * `TAG_GROUP_COLORS` 逐字相同 —— 颜色会显示在前端的 tag 徽章上。
 */
export const TAG_GROUP_COLORS: Record<string, string> = {
  general: '#006192',
  character: '#8243ca',
  artist: '#f30000',
  copyright: '#00b300',
}

/** 还没有任何自动标签、且没被拉黑的图片，按 id 升序。 */
export function listTaggerPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
): PendingImage[] {
  const sql
    = `SELECT p.id, p.full_path FROM posts p `
      + `WHERE NOT EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.is_auto = 1) `
      + `AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = limit === undefined ? [TAGGER_WORKER] : [TAGGER_WORKER, limit]
  const rows = sqlite.prepare<unknown[], { id: number, full_path: string }>(sql).all(...params)
  return rows.map(r => ({ postId: r.id, path: `${targetDir}/${r.full_path}` }))
}

/** 确保四个规范 tag 组存在，返回 `{组名: id}`。 */
export function ensureCanonicalTagGroups(sqlite: BetterSqlite3.Database): Record<string, number> {
  const insert = sqlite.prepare(
    'INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
  )
  const select = sqlite.prepare<[string], { id: number }>('SELECT id FROM tag_groups WHERE name = ?')
  const out: Record<string, number> = {}
  sqlite.transaction(() => {
    for (const [name, color] of Object.entries(TAG_GROUP_COLORS)) {
      insert.run(name, color)
      out[name] = select.get(name)!.id
    }
  })()
  return out
}

/** WDTagger 对一张图的输出 —— 与 `@pictoria/contracts` 的 `TaggerResult` 同形。 */
export interface TaggerRow {
  postId: number
  generalTags: string[]
  characterTags: string[]
  rating: string
}

/** `general`/`sensitive`/`questionable`/`explicit` → 1..4，其余 0。与 Python 侧同表。 */
export function ratingToInt(rating: string): number {
  return ({ general: 1, sensitive: 2, questionable: 3, explicit: 4 } as Record<string, number>)[rating] ?? 0
}

/**
 * 把一批 tagger 结果落库，返回**仍然没有**自动标签的那些 id。
 *
 * 三件事在一个事务里：tag 名 upsert（分 general / character 两组）、
 * `post_has_tag` 关联、rating 补写。
 *
 * 返回值是落库后的复查结果，不是可有可无的信息：`post_has_tag` 的插入是
 * `ON CONFLICT DO NOTHING`，所以当 tagger 产出的每一个标签**都已经**作为手工标签
 * （`is_auto = 0`）存在时 —— Danbooru 导入的图很常见 —— 一行 `is_auto = 1` 都不会
 * 建出来，而待办查询下一轮又会选中它。调用方要把这些 id 拉黑，因为重跑 tagger
 * 只会得到同样被遮住的结果。
 *
 * rating 只在原值为 0（未评级）时写。人工评过的不会被模型覆盖。
 */
export function persistTaggerResults(
  sqlite: BetterSqlite3.Database,
  rows: TaggerRow[],
  groups: Record<string, number>,
): number[] {
  if (!rows.length)
    return []

  // 整批去重，于是一个被很多图共享的标签只 upsert 一次
  const general = new Set<string>()
  const character = new Set<string>()
  const links: Array<[number, string]> = []
  for (const r of rows) {
    const own = new Set([...r.generalTags, ...r.characterTags])
    for (const t of r.generalTags) general.add(t)
    for (const t of r.characterTags) character.add(t)
    for (const t of own) links.push([r.postId, t])
  }

  // 已有 group_id 的标签不被改组：手工归过组的不该被模型的猜测覆盖
  const upsertTag = sqlite.prepare(
    'INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE '
    + 'SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END',
  )
  const link = sqlite.prepare(
    'INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 1) '
    + 'ON CONFLICT (post_id, tag_name) DO NOTHING',
  )
  const setRating = sqlite.prepare(
    'UPDATE posts SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND rating = 0',
  )

  sqlite.transaction(() => {
    for (const name of general) upsertTag.run(name, groups.general)
    for (const name of character) upsertTag.run(name, groups.character)
    for (const [postId, name] of links) link.run(postId, name)
    for (const r of rows) {
      const rating = ratingToInt(r.rating)
      if (rating !== 0)
        setRating.run(rating, r.postId)
    }
  })()

  const ids = rows.map(r => r.postId)
  return sqlite
    .prepare<unknown[], { id: number }>(
      `SELECT p.id FROM posts p WHERE p.id IN (${placeholders(ids.length)}) `
      + `AND NOT EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.is_auto = 1)`,
    )
    .all(...ids)
    .map(r => r.id)
}
