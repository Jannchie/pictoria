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

// ─── 待办扫描的水位线 ──────────────────────────────────────────────────

/**
 * 「这个 id 以下已经确认没有待办了」的水位线，按**连接**、按**循环**存。
 *
 * 五个 `list*Pending` 的形状都是"按 `p.id` 升序、扫到够数为止"，而待办**总是在库尾**
 * （新 post 的 id 最大，老 post 早就算完了）。没有下界的话，每一批都要从 id=1 开始
 * 把整张 `posts` 逐行探一遍才碰到第一个候选：真实库（`posts` 232,240 行、
 * `post_has_tag` 12,373,331 行）实测一批的代价是 basics 214 ms、waifu 287 ms、
 * embedding 531 ms、silva ×2 各 ~440 ms、tagger 1,811 ms —— 六条循环一轮**约 3.7 秒**
 * 的同步阻塞。better-sqlite3 是同步的，所以那 3.7 秒里事件循环上的一切都停着。
 *
 * 空闲时这还只是每 30 秒一次，但大规模导入期间待办**持续非空**，六条循环各自
 * "算完一批立刻扫下一批"，于是这 3.7 秒变成几乎连续的 —— 这就是导入时其它 API
 * 请求会卡住的原因。
 *
 * 水位线把它变成主键上的一次范围定位：查询加一条 `p.id >= ?`，同一批实测
 * tagger 2.1 ms、waifu 0.4 ms、basics 0.2 ms。
 *
 * 推进规则只有两条，两条都是"扫描本身已经证明了的事"：
 *
 * * 这一轮扫出了候选 → 水位线落在**第一个候选**的 id 上。查询按 id 升序，所以它
 *   之前的每一行都被判定过、都不是待办。
 * * 这一轮一条都没扫到 → 水位线落在**扫描开始那一刻**的 `MAX(id) + 1`。
 *   （`maxPostId` 必须在查询**之前**读：查询期间插进来的新 post id 更大，读在后面
 *   就会把它们一起跳过，表现是新导入的图永远不被 backfill 碰。）
 *
 * ⚠️⚠️ **不变式只对"单行状态从待办变成已完成"成立，反方向必须靠 `force`。**
 * 清空 `post_process_failures` 黑名单、手工摘掉某张图最后一个 `is_auto` 标签、删掉
 * 某个 scorer 的分数行、把 `sha256`/`arthash`/`dominant_color` 清回空值 —— 这些都会
 * 让一个 id **低于**水位线的老 post 重新变成待办，而水位线不会自己退回去。命中的
 * 表现是**静默的**：没有报错、没有日志，backfill 就是永远不再动那张图。所以每一条
 * "让老 post 重新变成待办"的路径都必须走到 `wakeAllBackfills()`
 * （`apps/api/src/scheduler.ts`），它会给每条循环立一个 `force` 标志，下一轮带
 * `{ force: true }` 进来把水位线清零、从头重扫一次。加新的这类写点时，漏掉那一句
 * 的代价就是那些 post 永久停在待办状态。
 *
 * 这一段替换掉的是原来的 `MAX(id)` 指纹门（"上一轮扫空且 MAX(id) 没变就跳过"）。
 * 逃生通道和风险面与那一版**完全相同** —— 同样是 `force`、同样是那几条写路径；
 * 差别在于指纹门只在**全库算完**时才省得下钱（一有待办就整个失效，而那正是导入
 * 期间的常态），水位线则是每一批都省。空库/空扫的场景两者等价：`MAX(id)+1` 的
 * 水位线让下一轮的 `p.id >= ?` 直接定位到表尾，扫 0 行。
 *
 * 按**连接**存而不是整个模块存一份：这个包里其它函数都是 `(sqlite, args)` 的纯形式，
 * 一份模块级单例会让同进程里的两条连接（测试、脚本、将来的只读副本）共用一条水位线，
 * 而两个库的 id 空间不同，表现是一个库的待办被另一个库的进度永久跳过。`WeakMap`
 * 让它跟着连接一起消失。
 *
 * 按**循环**存（`Map<key, floor>`）而不是一个共用值：六条循环各自消化待办的进度不同，
 * 共用一条水位线会让跑得快的那条把还有活的那条一起推过头。
 */
const scanFloor = new WeakMap<BetterSqlite3.Database, Map<string, number>>()

/** 五个待办查询共用的可选参数。 */
export interface PendingScanOpts {
  /**
   * 把水位线清零，强制这一次从 id=1 重新全扫。
   *
   * 由 `wakeAllBackfills()` 一路传下来 —— 见上面那段 ⚠️：它是"低于水位线的老 post
   * 重新变成待办"唯一的逃生通道。
   */
  force?: boolean
}

/** 扫描开始那一刻的 `MAX(id)`。主键探测，亚毫秒。 */
function maxPostId(sqlite: BetterSqlite3.Database): number {
  return sqlite
    .prepare<[], { max_id: number }>('SELECT COALESCE(MAX(id), 0) AS max_id FROM posts')
    .get()!
    .max_id
}

/** 这一轮该从哪个 id 开始扫。`force` 除了返回 0 还要把旧水位删掉，否则下一轮又被推回去。 */
function readFloor(sqlite: BetterSqlite3.Database, key: string, force: boolean): number {
  if (force) {
    scanFloor.get(sqlite)?.delete(key)
    return 0
  }
  return scanFloor.get(sqlite)?.get(key) ?? 0
}

/** 记下这一轮证明出来的新水位。`floor` 由调用方按上面那两条规则算好。 */
function writeFloor(sqlite: BetterSqlite3.Database, key: string, floor: number): void {
  let per = scanFloor.get(sqlite)
  if (!per) {
    per = new Map()
    scanFloor.set(sqlite, per)
  }
  per.set(key, floor)
}

/**
 * 带水位线的待办扫描 —— `listWaifuPending` / `listTaggerPending` / `listBasicsPending`
 * 共用的那一半。
 *
 * 三条循环差的只有"什么算待办"（`where`，外加 waifu 需要的那条 LEFT JOIN）和要取哪几列；
 * 水位线的读写、`p.id >= ?` 的下界、扩展名与黑名单过滤、`ORDER BY p.id` 加可选 `LIMIT`、
 * 以及参数的拼装顺序在三处逐字相同。收在这里的**主要**理由不是省那 40 行，而是
 * `scanFloor` 那段注释里的两条推进规则和一条读取顺序（`maxPostId` 必须在查询之前读，
 * 否则查询期间插进来的新 post 会被永久跳过）现在只有一处实现能违反。
 */
function scanByFloor<R extends { id: number }>(
  sqlite: BetterSqlite3.Database,
  opts: {
    /** 水位线的键。六条循环各存各的，见 `scanFloor`。 */
    key: string
    /** `post_process_failures` 的 worker 列值。 */
    workerKey: string
    /** `SELECT` 之后、`FROM posts p` 之前的列清单。 */
    columns: string
    /** 可选的 JOIN 片段，接在 `FROM posts p` 之后。 */
    join?: string
    /** 这条循环自己的"算待办"条件，与下界和公共过滤 AND 在一起。 */
    where: string
    limit?: number
    force: boolean
  },
): R[] {
  const floor = readFloor(sqlite, opts.key, opts.force)
  // 必须在查询**之前**读，理由见 `scanFloor` 的注释。
  const maxId = maxPostId(sqlite)

  const sql
    = `SELECT ${opts.columns} FROM posts p ${opts.join ?? ''}`
      + `WHERE p.id >= ? AND ${opts.where} AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} `
      + `ORDER BY p.id${opts.limit === undefined ? '' : ' LIMIT ?'}`
  const params: unknown[] = [floor, opts.workerKey, ...(opts.limit === undefined ? [] : [opts.limit])]
  const rows = sqlite.prepare<unknown[], R>(sql).all(...params)

  writeFloor(sqlite, opts.key, rows[0]?.id ?? maxId + 1)
  return rows
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
  // 一个 scorer 一条水位线：silva 打完了不该把还在跑的 silva_luna 一起推过头。
  const key = `silva:${scorer}`
  const floor = readFloor(sqlite, key, force)
  const maxId = maxPostId(sqlite)

  const rows = sqlite
    .prepare<[number, string, string], { id: number }>(
      `SELECT p.id FROM posts p `
      + `WHERE p.id >= ? `
      + `AND NOT EXISTS (SELECT 1 FROM ${AESTHETIC_SCORES_TABLE} pas WHERE pas.post_id = p.id AND pas.scorer = ?) `
      + `AND ${notFailedClause('p')} `
      + `ORDER BY p.id`,
    )
    .iterate(floor, scorer, aestheticWorkerKey(scorer))

  // 那次 vec0 扫描推迟到**真的出现第一个候选**才付：全库打完分之后候选恒为空，
  // 被 wakeAllBackfills 强制重扫的那些轮次也就不必白扫一遍虚表。
  // better-sqlite3 允许在一个迭代器打开期间跑别的**读**语句（写才会报
  // "database connection is busy"），所以懒加载放在循环里是安全的。
  let embedded: Set<number> | undefined
  const pending: number[] = []
  // 水位线记的是**第一个候选**，不是第一个 pending：候选里没向量的那些仍然是待办
  // （只是这一轮还算不了），把水位推过它们等于等它们拿到向量之后再也不来看一眼。
  let firstCandidate: number | undefined
  for (const row of rows) {
    firstCandidate ??= row.id
    // 判断放在 push 之前：limit === 0 时要返回空，而不是"至少一个"。
    if (limit !== undefined && pending.length >= limit)
      break
    embedded ??= new Set(
      sqlite
        .prepare<[number], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE} WHERE post_id >= ?`)
        .all(floor)
        .map(r => r.post_id),
    )
    if (embedded.has(row.id))
      pending.push(row.id)
  }

  writeFloor(sqlite, key, firstCandidate ?? maxId + 1)
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
 * 带水位线（见 `scanFloor`）：没有下界的一批实测 287 ms，`p.id >= ?` 之后 0.4 ms。
 */
export function listWaifuPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): PendingImage[] {
  const rows = scanByFloor<{ id: number, full_path: string }>(sqlite, {
    key: 'waifu',
    workerKey: WAIFU_WORKER_KEY,
    columns: 'p.id, p.full_path',
    join: 'LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id ',
    where: 'pws.post_id IS NULL',
    limit,
    force,
  })
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
 * 带水位线（见 `scanFloor`），而且这里最值钱：那条 `NOT EXISTS` 打在
 * `post_has_tag` 的 1237 万行上，没有下界时一批要 1,811 ms —— 六条循环那 3.7 秒
 * 的一轮里它一个人占了一半。`p.id >= ?` 之后是 2.1 ms。
 *
 * ⚠️ 手工摘掉一张图最后一个 `is_auto = 1` 标签会让它重新变成待办，而它的 id 在
 * 水位线**以下**。那条路径必须走 `wakeAllBackfills()`，否则它永远不会被重新打标。
 */
export function listTaggerPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): PendingImage[] {
  const rows = scanByFloor<{ id: number, full_path: string }>(sqlite, {
    key: 'tagger',
    workerKey: TAGGER_WORKER_KEY,
    columns: 'p.id, p.full_path',
    where: 'NOT EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.is_auto = 1)',
    limit,
    force,
  })
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
 * 门控（见 `scanFloor`）最早就是为这条循环写的：它是五个待办查询里唯一没法用 SQL
 * 做反连接的 —— `NOT EXISTS (SELECT 1 FROM vec WHERE post_id = p.id)` 不会走 rowid
 * 点查而是**每行都全扫一遍虚表**，实测 7,335 ms，比这里"两次全扫 + JS 差集"的
 * 401 ms 还慢 18 倍。所以那两次扫描留着，改成让水位线把它们的范围压到库尾：
 * `p.id >= ?` 之外，vec0 那次也带上 `post_id >= ?`（实测 76 ms → 39 ms）。
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
  const floor = readFloor(sqlite, 'embedding', force)
  const maxId = maxPostId(sqlite)

  const candidates = sqlite
    .prepare<[number, string], { id: number, full_path: string }>(
      `SELECT p.id, p.full_path FROM posts p `
      + `WHERE p.id >= ? AND ${IMAGE_EXT_WHERE} AND ${notFailedClause('p')} ORDER BY p.id`,
    )
    .all(floor, EMBEDDING_WORKER_KEY)

  // 候选为空 = 水位线以上一张图都没有，vec0 那次扫描问不出任何东西。这是稳态
  // （全库算完、水位线在 MAX(id)+1）的常态，而 vec0 是虚表：`post_id >= ?` 不走
  // rowid 索引，即便一行都不返回也要 40 ms。空转的每一轮都省这一下。
  if (!candidates.length) {
    writeFloor(sqlite, 'embedding', maxId + 1)
    return []
  }

  const embedded = new Set(
    sqlite
      .prepare<[number], { post_id: number }>(`SELECT post_id FROM ${SIGLIP2_TABLE} WHERE post_id >= ?`)
      .all(floor)
      .map(r => r.post_id),
  )
  const pending = candidates.filter(r => !embedded.has(r.id))
  // 这里可以推到第一个 **pending** 而不是第一个候选（silva 那边不行）：已经有向量的
  // 候选就是已完成，跳过它和跳过任何一行已完成的行是同一件事。
  writeFloor(sqlite, 'embedding', pending[0]?.id ?? maxId + 1)
  const slice = limit === undefined ? pending : pending.slice(0, limit)
  return slice.map(r => ({ postId: r.id, path: `${targetDir}/${r.full_path}` }))
}

/**
 * 把这条连接上**所有**循环的水位线清零，等价于下一次每条都 `{ force: true }`。
 *
 * 生产路径不走这里 —— 调度器用的是 `PendingScanOpts.force`（由 `wakeAllBackfills()`
 * 一路传下来）。这个函数是给测试用的：水位线是**连接级**状态，而测试套件共用一条
 * 连接、每个用例之间只 `DELETE FROM` 清表，清不掉水位线。不在 `beforeEach` 里调它
 * 的话，前一个用例把水位推到 `MAX(id)+1` 会让后一个用例插进去的低 id 行整批看不见 ——
 * 表现是一堆"待办查询返回空"的失败，而查询本身没有任何问题。
 */
export function resetScanFloors(sqlite: BetterSqlite3.Database): void {
  scanFloor.get(sqlite)?.clear()
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
 * 带水位线（见 `scanFloor`）：没有下界的一批实测 214 ms，`p.id >= ?` 之后 0.2 ms。
 */
export function listBasicsPending(
  sqlite: BetterSqlite3.Database,
  targetDir: string,
  limit?: number,
  { force = false }: PendingScanOpts = {},
): BasicsPending[] {
  const rows = scanByFloor<{
    id: number
    full_path: string
    sha256: string | null
    arthash: string | null
    dominant_color: Buffer | null
  }>(sqlite, {
    key: 'basics',
    workerKey: BASICS_WORKER_KEY,
    columns: 'p.id, p.full_path, p.sha256, p.arthash, p.dominant_color',
    where: `(p.sha256 = '' OR p.arthash IS NULL OR p.arthash = '' OR p.dominant_color IS NULL)`,
    limit,
    force,
  })
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
