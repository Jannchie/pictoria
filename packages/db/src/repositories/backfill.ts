/**
 * Backfill 的**数据**一侧：待办查询与结果落库。
 *
 * 计算不在这里，也不会在这里 —— 它在 Python worker 里，通过 cairnq 往返
 * （见 `docs/refactor-monorepo-hono.md` §D1）。这个文件是那条原则里"所有数据库
 * 写入在 TS"的那一半：待办查询挑出要算什么，结果函数把算完的东西写回去。
 */
import { placeholders } from '../sql.js'
import { BASICS_WORKER_KEY, EMBEDDING_WORKER_KEY, TAGGER_WORKER_KEY, WAIFU_WORKER_KEY } from '@pictoria/contracts'
import type BetterSqlite3 from 'better-sqlite3'
import { Buffer } from 'node:buffer'
import { AESTHETIC_SCORES_TABLE } from '../scorers.js'
import { postExists } from './posts.js'
import { SIGLIP2_TABLE } from './vectors.js'

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

// ─── 待办扫描的指纹门控 ────────────────────────────────────────────────

/**
 * 上一次"扫出来是空"的那一刻 `posts` 的 `MAX(id)`，按**连接**、按**循环**存。
 *
 * 五个 `list*Pending` 都由调度器每 `IDLE_MS`（30 秒）调一轮，而库全算完之后它们
 * **恒返回 0 行** —— 那份工作 100% 是白干的。真实库（`posts` 229,129 行、
 * `post_has_tag` 12,094,557 行）实测一轮同步阻塞约 650 ms（warm）/ 2.7 s（cold），
 * tagger 那条 `NOT EXISTS` 打在 1209 万行上独占其中的 400~700 ms。better-sqlite3
 * 是同步的，所以这就是每 30 秒把事件循环占住一次，永远。
 *
 * 指纹是 `posts` 的 `MAX(id)` —— 一次 O(log n) 的主键探测，亚毫秒。新 post 是待办的
 * **主要**来源，而 id 是 AUTOINCREMENT、永不复用，所以任何新 post 都严格增大
 * MAX(id)：指纹没变 + 上一轮扫出来是空 ⇒ 这一轮也是空。
 *
 * 有意**不**掺 `COUNT(*)`：它多检测到的只有删除，而删除永远不产生待办，却会击穿
 * 这道门 —— 每 tick 删一张图的工作流会让全库已算完的库每 30 秒白付一次全扫；且
 * 稳态下 COUNT 本身就是一次全表扫。
 *
 * ⚠️⚠️ **`MAX(id)` 不是待办的唯一来源，这是整套门控唯一的、也是会致命的缺口。**
 * 清空 `post_process_failures` 黑名单、手工摘掉某张图最后一个 `is_auto` 标签、删掉
 * 某个 scorer 的分数行 —— 这些都会造出新待办，而一条也不动 `MAX(id)`。门控命中的
 * 表现是**静默的**：没有报错、没有日志，backfill 就是永远不再动那张图。所以每一条
 * "产生了新工作但 MAX(id) 没变"的路径都必须走到 `wakeAllBackfills()`
 * （`apps/api/src/scheduler.ts`），它会给每条循环立一个 `force` 标志，下一轮带
 * `{ force: true }` 进来把这道门整个绕开、强制重扫一次。加新的这类写点时，漏掉那一句
 * 的代价就是 backfill 永久停摆。
 *
 * 按**连接**存而不是整个模块存一份：这个包里其它函数都是 `(sqlite, args)` 的纯形式，
 * 一份模块级单例会让同进程里的两条连接（测试、脚本、将来的只读副本）共用一个指纹，
 * 而两个库恰好同 max id 时的表现是"待办被永久判成空"。`WeakMap` 让它跟着连接一起消失。
 *
 * 按**循环**存（`Map<key, maxId>`）而不是一个共用值：六条循环各自消化待办的进度不同，
 * 共用一个指纹会让先扫空的那条把还有活的那条一起关掉。
 */
const scanMemo = new WeakMap<BetterSqlite3.Database, Map<string, number>>()

/** 五个待办查询共用的可选参数。 */
export interface PendingScanOpts {
  /**
   * 绕过指纹门，强制这一次重新全扫（并丢掉已记下的指纹）。
   *
   * 由 `wakeAllBackfills()` 一路传下来 —— 见上面那段 ⚠️：它是"新工作出现了但
   * `MAX(id)` 没变"唯一的逃生通道。
   */
  force?: boolean
}

/** 指纹本身。主键探测，亚毫秒。 */
function maxPostId(sqlite: BetterSqlite3.Database): number {
  return sqlite
    .prepare<[], { max_id: number }>('SELECT COALESCE(MAX(id), 0) AS max_id FROM posts')
    .get()!
    .max_id
}

/** 这一轮能不能直接短路。`force` 除了返回 false 还要把旧指纹删掉，否则下一轮又被挡住。 */
function memoHit(sqlite: BetterSqlite3.Database, key: string, maxId: number, force: boolean): boolean {
  if (force) {
    scanMemo.get(sqlite)?.delete(key)
    return false
  }
  return scanMemo.get(sqlite)?.get(key) === maxId
}

/** 只有"这一轮确实一条待办都没有"才记指纹；有待办就清掉 —— 下一轮还得回来接着扫。 */
function memoWrite(sqlite: BetterSqlite3.Database, key: string, maxId: number, empty: boolean): void {
  let per = scanMemo.get(sqlite)
  if (!per) {
    per = new Map()
    scanMemo.set(sqlite, per)
  }
  if (empty)
    per.set(key, maxId)
  else
    per.delete(key)
}

/**
 * 有 SigLIP2 向量、但还没有 `scorer` 分数的 post id，按 id 升序。
 *
 * "有没有向量"用一次 vec0 的 post_id 列全扫做集合求交，而不是每行一个
 * `EXISTS` —— vec0 的点查是虚表探测不是 B-tree 探测，逐行探在库规模上要几十秒。
 * 候选顺序（p.id 升序）在过滤后保持不变。
 *
 * 候选是**流式**过的（`.iterate()` + 够数就 break），不是 `.all()` 之后再 `.slice()`：
 * "有向量"这个条件没法用 SQL 表达，所以 `LIMIT` 只能推到 JS 这一侧的循环里。全量物化
 * 的代价在刚导入完的库上是每批白建一个 22.9 万个 id 的数组（一批只要 64 个），而
 * silva 有两个 scorer、每批都来一次。
 */
export function listSilvaPending(
  sqlite: BetterSqlite3.Database,
  scorer: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): number[] {
  // 一个 scorer 一个指纹：silva 打完了不该把还在跑的 silva_luna 一起关掉。
  const key = `silva:${scorer}`
  const maxId = maxPostId(sqlite)
  if (memoHit(sqlite, key, maxId, force))
    return []

  const rows = sqlite
    .prepare<[string, string], { id: number }>(
      `SELECT p.id FROM posts p `
      + `WHERE NOT EXISTS (SELECT 1 FROM ${AESTHETIC_SCORES_TABLE} pas WHERE pas.post_id = p.id AND pas.scorer = ?) `
      + `AND ${notFailedClause('p')} `
      + `ORDER BY p.id`,
    )
    .iterate(scorer, aestheticWorkerKey(scorer))

  // 那次 vec0 全扫（78 ms）推迟到**真的出现第一个候选**才付：全库打完分之后候选恒为
  // 空，被 wakeAllBackfills 强制重扫的那些轮次也就不必白扫一遍虚表。
  // better-sqlite3 允许在一个迭代器打开期间跑别的**读**语句（写才会报
  // "database connection is busy"），所以懒加载放在循环里是安全的。
  let embedded: Set<number> | undefined
  const pending: number[] = []
  for (const row of rows) {
    // 判断放在 push 之前：limit === 0 时要返回空，而不是"至少一个"。
    if (limit !== undefined && pending.length >= limit)
      break
    embedded ??= new Set(
      sqlite.prepare<[], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE}`).all().map(r => r.post_id),
    )
    if (embedded.has(row.id))
      pending.push(row.id)
  }

  memoWrite(sqlite, key, maxId, pending.length === 0)
  return pending
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
 *
 * 带指纹门（见 `scanMemo`）：全库打完分之后这条查询恒返回 0 行，实测每轮仍要
 * 73 ms（warm）/ 150 ms（cold）的同步阻塞。
 */
export function listWaifuPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): PendingImage[] {
  const maxId = maxPostId(sqlite)
  if (memoHit(sqlite, 'waifu', maxId, force))
    return []

  const sql
    = `SELECT p.id, p.full_path FROM posts p `
      + `LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id `
      + `WHERE pws.post_id IS NULL AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = limit === undefined ? [WAIFU_WORKER_KEY] : [WAIFU_WORKER_KEY, limit]
  const rows = sqlite.prepare<unknown[], { id: number, full_path: string }>(sql).all(...params)

  memoWrite(sqlite, 'waifu', maxId, rows.length === 0)
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

/**
 * WDTagger 产出的四个组的颜色。与 Python 侧 `services/wd_tagging.py` 的
 * `TAG_GROUP_COLORS` 逐字相同 —— 颜色会显示在前端的 tag 徽章上。
 *
 * ⚠️ 这是**颜色表**，不是规范组的清单。规范组多一个 `meta`（见
 * `CANONICAL_TAG_GROUPS`）：tagger 不产出它，但两个导入器都往里写。
 */
export const TAG_GROUP_COLORS: Record<string, string> = {
  general: '#006192',
  character: '#8243ca',
  artist: '#f30000',
  copyright: '#00b300',
}

/**
 * 五个规范 tag 组，**按优先级排序**。承自已删除的
 * `server/commands.py::CANONICAL_TAG_GROUPS`，逐字相同（顺序也是）。
 *
 * 两件事都靠它：
 *
 * * **组必须存在**。两个导入器都拿 `ensureCanonicalTagGroups` 的结果当映射用
 *   （danbooru 侧 `for t, gid in type_to_group_id.items(): tag_string_{t}`，
 *   gallery-dl 侧 `type_to_group_id.get(group_name)`），组不在这张表里 = 那一类
 *   标签**根本不会被读**。少了 `meta` 的后果是每次 danbooru 导入静默丢掉
 *   `highres` / `absurdres` / `commentary` / `bad_id`，而读侧还在按它排序
 *   （`post-detail.ts`）和过滤（`filters.ts`）。
 * * **顺序即优先级**。一个标签同时出现在多个 `tag_string_*` 里时，先列的组赢
 *   （Python 侧 `_build_tag_to_group` 的 `setdefault`）。JS 的对象和 Python 的
 *   dict 都保插入顺序，JSON 也是，所以这个顺序一路传到 worker 都还在。
 */
export const CANONICAL_TAG_GROUPS: readonly string[] = ['artist', 'character', 'copyright', 'general', 'meta']

/** 规范组的颜色；`meta` 不在 tagger 的颜色表里，取 Python 侧同款的黑色兜底。 */
const CANONICAL_GROUP_COLOR = '#000000'

/**
 * 还没有任何自动标签、且没被拉黑的图片，按 id 升序。
 *
 * 带指纹门（见 `scanMemo`），而且这里最值钱：那条 `NOT EXISTS` 打在
 * `post_has_tag` 的 1209 万行上，全库标完之后恒返回 0 行却仍要 421 ms（warm）/
 * 2403 ms（cold）—— 五条循环那 650 ms 的一轮里它一个人占了大半。
 *
 * ⚠️ 手工摘掉一张图最后一个 `is_auto = 1` 标签会让它重新变成待办，而 `MAX(id)`
 * 一动不动。那条路径必须走 `wakeAllBackfills()`，否则它永远不会被重新打标。
 */
export function listTaggerPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): PendingImage[] {
  const maxId = maxPostId(sqlite)
  if (memoHit(sqlite, 'tagger', maxId, force))
    return []

  const sql
    = `SELECT p.id, p.full_path FROM posts p `
      + `WHERE NOT EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.is_auto = 1) `
      + `AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = limit === undefined ? [TAGGER_WORKER_KEY] : [TAGGER_WORKER_KEY, limit]
  const rows = sqlite.prepare<unknown[], { id: number, full_path: string }>(sql).all(...params)

  memoWrite(sqlite, 'tagger', maxId, rows.length === 0)
  return rows.map(r => ({ postId: r.id, path: `${targetDir}/${r.full_path}` }))
}

/** 确保五个规范 tag 组存在，返回 `{组名: id}`，键序即 `CANONICAL_TAG_GROUPS` 的优先级序。 */
export function ensureCanonicalTagGroups(sqlite: BetterSqlite3.Database): Record<string, number> {
  const insert = sqlite.prepare(
    'INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
  )
  const select = sqlite.prepare<[string], { id: number }>('SELECT id FROM tag_groups WHERE name = ?')
  const out: Record<string, number> = {}
  sqlite.transaction(() => {
    for (const name of CANONICAL_TAG_GROUPS) {
      insert.run(name, TAG_GROUP_COLORS[name] ?? CANONICAL_GROUP_COLOR)
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

// ─── embedding（SigLIP 2 检索向量） ────────────────────────────────────

/**
 * 还没有 SigLIP2 向量、且没被拉黑的图片，按 id 升序。
 *
 * "已经有向量了吗"用一次 vec0 post_id 列全扫做集合求差，而不是
 * `LEFT JOIN ... IS NULL` —— vec0 的点查是虚表探测不是 B-tree 探测，join 会让它
 * 每行 posts 跑一次（17 万行时是几十秒）。
 *
 * 指纹门（见 `scanMemo`）最早就是为这条循环写的：它是五个待办查询里唯一没法用 SQL
 * 做反连接的 —— `NOT EXISTS (SELECT 1 FROM vec WHERE post_id = p.id)` 不会走 rowid
 * 点查而是**每行都全扫一遍虚表**，实测 7,335 ms，比这里"两次全扫 + JS 差集"的
 * 401 ms 还慢 18 倍。所以那两次全扫留着，改成能跳过它们。
 *
 * ⚠️ 不能用"`count(posts) == count(vec0)` 就返回空"那种门控：两边的差不只是待办，
 * 还有孤儿向量（迁移 0015 清了 67 条存量，`upsertVectors` 堵了源头）。只要有一条
 * 孤儿，那个门控就永远不命中。
 */
export function listEmbeddingPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): PendingImage[] {
  const maxId = maxPostId(sqlite)
  if (memoHit(sqlite, 'embedding', maxId, force))
    return []

  const candidates = sqlite
    .prepare<[string], { id: number, full_path: string }>(
      `SELECT p.id, p.full_path FROM posts p `
      + `WHERE ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} ORDER BY p.id`,
    )
    .all(EMBEDDING_WORKER_KEY)

  const embedded = new Set(
    sqlite.prepare<[], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE}`).all().map(r => r.post_id),
  )
  const pending = candidates.filter(r => !embedded.has(r.id))
  memoWrite(sqlite, 'embedding', maxId, pending.length === 0)
  const slice = limit === undefined ? pending : pending.slice(0, limit)
  return slice.map(r => ({ postId: r.id, path: `${targetDir}/${r.full_path}` }))
}

/**
 * 丢掉这条连接上 **embedding** 那条循环的指纹，强制下一次重新全扫。
 *
 * 生产路径不走这里 —— 调度器用的是 `PendingScanOpts.force`（由 `wakeAllBackfills()`
 * 一路传下来），那条通道对五条循环一视同仁。这个函数留着是给测试用的：它只清
 * embedding 一个键，别指望它能把 tagger / waifu / silva / basics 的指纹一起掀掉。
 */
export function resetEmbeddingScanMemo(sqlite: BetterSqlite3.Database): void {
  scanMemo.get(sqlite)?.delete('embedding')
}

/**
 * 批量写入 SigLIP2 向量。
 *
 * ⚠️ **rowid 必须传 `BigInt`**。better-sqlite3 把 JS `number` 按 REAL 绑定，而 vec0
 * 的主键只收整数，会直接报 `Only integers are allowed for primary key values`。
 *
 * vec0 不支持 `ON CONFLICT`，所以 upsert 是 DELETE + INSERT 手工模拟，两条语句在
 * 一个事务里 —— 中间被打断会留下一个没有向量的 post，而它在待办查询里看起来是
 * "从没算过"，于是整批白算一次。
 *
 * 返回**真正写进去**的条数：post 已经被删掉的那些会被跳过，调用方拿它计数才不会
 * 把跳过的也算成写入（`scheduler.ts` 用这个数决定要不要触发近重复重组）。
 */
export function upsertVectors(
  sqlite: BetterSqlite3.Database,
  rows: Array<{ postId: number, embedding: Buffer }>,
): number {
  if (!rows.length)
    return 0
  const del = sqlite.prepare(`DELETE FROM ${SIGLIP2_TABLE} WHERE post_id = ?`)
  const ins = sqlite.prepare(`INSERT INTO ${SIGLIP2_TABLE}(post_id, embedding) VALUES (?, ?)`)
  // post 还在不在 —— vec0 是虚表，不参与 FK 级联，所以这一层得自己判。
  //
  // 竞态是真实发生过的（迁移 0015 清掉了 67 条存量）：待办查询选中一个 post，任务
  // 提交出去算几秒到几分钟，这期间 sync 发现文件没了把行删掉，结果回来照写不误。
  // 写进去就再没人删得掉它 —— 删除路径按 post id 清 vec0，而那个 post 已经没了。
  //
  // 逐行问而不是一次 `IN (...)`：一批最多 16 条（`EMBEDDING_TASK_BATCH`），实测
  // 32 次 rowid 点查合计 0.1 ms，省不出第二条代码路径的钱。
  let written = 0
  sqlite.transaction(() => {
    for (const r of rows) {
      if (!postExists(sqlite, r.postId))
        continue
      del.run(BigInt(r.postId))
      ins.run(BigInt(r.postId), r.embedding)
      written += 1
    }
  })()
  return written
}

// ─── basics（sha256 / arthash / 尺寸 / 调色板 / 主色 / 缩略图） ──────────

/** basics 待办的一条：路径 + 哪几样已经有了。 */
export interface BasicsPending {
  postId: number
  path: string
  relPath: string
  hasSha256: boolean
  hasArthash: boolean
  hasColor: boolean
}

/**
 * 还缺 sha256 / arthash / 主色中任意一样、且没被拉黑的图片，按 id 升序。
 *
 * 三个条件是 OR：缺任意一样就要重新解码一次（反正解码是同一次）。worker 拿到
 * `has*` 三个布尔值，只算缺的那几样。
 *
 * 带指纹门（见 `scanMemo`）：全库算完之后恒返回 0 行，实测每轮 32 ms（warm）/
 * 33 ms（cold）。
 */
export function listBasicsPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): BasicsPending[] {
  const maxId = maxPostId(sqlite)
  if (memoHit(sqlite, 'basics', maxId, force))
    return []

  const sql
    = `SELECT p.id, p.full_path, p.sha256, p.arthash, p.dominant_color FROM posts p `
      + `WHERE (p.sha256 = '' OR p.arthash IS NULL OR p.arthash = '' OR p.dominant_color IS NULL) `
      + `AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = limit === undefined ? [BASICS_WORKER_KEY] : [BASICS_WORKER_KEY, limit]
  const rows = sqlite
    .prepare<unknown[], {
      id: number
      full_path: string
      sha256: string | null
      arthash: string | null
      dominant_color: Buffer | null
    }>(sql)
    .all(...params)

  memoWrite(sqlite, 'basics', maxId, rows.length === 0)
  return rows
    .map(r => ({
      postId: r.id,
      path: `${targetDir}/${r.full_path}`,
      relPath: r.full_path,
      hasSha256: !!r.sha256,
      hasArthash: !!r.arthash,
      hasColor: r.dominant_color !== null,
    }))
}

/** worker 回传的一行 basics。 */
export interface BasicsRowIn {
  postId: number
  sha256: string | null
  size: number | null
  arthash: string | null
  width: number
  height: number
  colors: number[]
  dominantLab: [number, number, number] | null
}

/**
 * 批量落库 basics。
 *
 * 一条 UPDATE 模板覆盖所有行，不管这一行实际算了哪几样：`COALESCE` 让 null 保留
 * 列上原来的值。`dominant_color` 只从 NULL 写到有值 —— 不覆盖已经算过的。
 * `post_has_color` 则是整组替换。
 */
export function upsertBasics(
  sqlite: BetterSqlite3.Database,
  rows: BasicsRowIn[],
): void {
  if (!rows.length)
    return

  const main = sqlite.prepare(
    'UPDATE posts SET width = ?, height = ?, sha256 = COALESCE(?, sha256), '
    + 'size = CASE WHEN ? IS NULL THEN size ELSE ? END, arthash = COALESCE(?, arthash), '
    + 'updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  const dom = sqlite.prepare(
    'UPDATE posts SET dominant_color = ? WHERE id = ? AND dominant_color IS NULL',
  )
  const clearColors = sqlite.prepare('DELETE FROM post_has_color WHERE post_id = ?')
  const insColor = sqlite.prepare(
    'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)',
  )

  sqlite.transaction(() => {
    for (const r of rows)
      main.run(r.width, r.height, r.sha256, r.sha256, r.size, r.arthash, r.postId)
    for (const r of rows) {
      if (r.dominantLab)
        dom.run(Buffer.from(new Float32Array(r.dominantLab).buffer), r.postId)
    }
    for (const r of rows) {
      if (!r.colors.length)
        continue
      clearColors.run(r.postId)
      for (const [i, c] of r.colors.entries()) insColor.run(r.postId, i, c)
    }
  })()
}
