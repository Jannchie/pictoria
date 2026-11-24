/**
 * posts 表的写操作 —— 形状承自已退役的 Python 侧 `db/repositories/posts.py`。
 *
 * 近重复组的手动操作（解组 / 设封面 / 合组 / 标不同）在 `grouping.ts`。
 */
import { chunked, placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { BULK_UPDATABLE_FIELDS, UPDATABLE_FIELDS } from '../filters.js'
import { notifyRepending } from '../repending.js'
import { BACKFILL_WORKERS } from '../workers.js'
import { SIGLIP2_TABLE } from './vectors.js'

const UPDATE_SQL = (field: string, whereSql: string) =>
  `UPDATE posts SET ${field} = ?, updated_at = CURRENT_TIMESTAMP, `
  + `last_accessed_at = CURRENT_TIMESTAMP WHERE ${whereSql}`

/**
 * 更新一个白名单标量列，匹配到行返回 `true`。
 *
 * 需要新状态的调用方自己再查一次（例如 `getDetail`）—— 这样这里不必多做一次
 * SELECT。`field` 会被拼进 SQL，白名单是唯一的注入防线。
 */
export function updateField(
  sqlite: BetterSqlite3.Database,
  postId: number,
  field: string,
  value: unknown,
  /** 只对 score 有意义：这一分的打分情境，原样进 `post_score_events.source`。 */
  source: string | null = null,
): boolean {
  if (!UPDATABLE_FIELDS.has(field))
    throw new Error(`Field is not whitelisted for update: ${field}`)

  const stmt = sqlite.prepare(UPDATE_SQL(field, 'id = ?'))
  if (field !== 'score')
    return stmt.run(value, postId).changes > 0

  // 打分镜像到整个近重复组：一组差分对人来说是同一张画（同组的成对判决 94% 判平局，
  // 跨组只有 22%），所以分数属于组而不是属于某一张。这会覆盖成员单独得到的分数，
  // 0 分同样会清空整组。
  //
  // 关键是**先解析到组代表再散开**，而不是直接 `WHERE canonical_post_id = <被打分的 id>`：
  // 后者只在打分对象恰好是代表时才匹配得上，给成员打分时匹配 0 行 —— 代表和其它成员
  // 纹丝不动，而列表里显示的正是代表，于是用户看到自己刚打的分"没生效"。
  //
  // 一个事务：两条 UPDATE 之间被打断会让组和代表分叉。
  const mirror = sqlite.prepare(
    `UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP `
    + `WHERE id = (SELECT COALESCE(canonical_post_id, id) FROM posts WHERE id = ?) `
    + `   OR canonical_post_id = (SELECT COALESCE(canonical_post_id, id) FROM posts WHERE id = ?)`,
  )
  // 事件先于 UPDATE 写：`previous` 要读到动作之前的分。只记被操作的这一张 ——
  // 镜像带着改的成员不是独立判断（见 0025_post_score_events.sql）。
  const record = sqlite.prepare(
    'INSERT INTO post_score_events (post_id, score, previous, source) SELECT id, ?, score, ? FROM posts WHERE id = ?',
  )
  let matched = false
  sqlite.transaction(() => {
    record.run(value, source, postId)
    matched = stmt.run(value, postId).changes > 0
    if (matched)
      mirror.run(value, postId, postId)
  })()
  return matched
}

/** 批量更新一个白名单列。score 同样镜像到各组成员（理由同上）。 */
export function bulkUpdateField(
  sqlite: BetterSqlite3.Database,
  ids: number[],
  field: string,
  value: unknown,
): void {
  if (!BULK_UPDATABLE_FIELDS.has(field))
    throw new Error(`Field is not whitelisted for bulk update: ${field}`)
  if (!ids.length)
    return

  const stmt = sqlite.prepare(UPDATE_SQL(field, `id IN (${placeholders(ids.length)})`))
  if (field !== 'score') {
    stmt.run(value, ...ids)
    return
  }

  // 同 `updateField`：先把每个 id 解析成它所在组的代表，再散到「代表 + 代表的成员」。
  const heads = `SELECT COALESCE(canonical_post_id, id) FROM posts WHERE id IN (${placeholders(ids.length)})`
  const mirror = sqlite.prepare(
    `UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP `
    + `WHERE id IN (${heads}) OR canonical_post_id IN (${heads})`,
  )
  const record = sqlite.prepare(
    'INSERT INTO post_score_events (post_id, score, previous, bulk) '
    + `SELECT id, ?, score, 1 FROM posts WHERE id IN (${placeholders(ids.length)}) ORDER BY id`,
  )
  sqlite.transaction(() => {
    record.run(value, ...ids)
    stmt.run(value, ...ids)
    mirror.run(value, ...ids, ...ids)
  })()
}

/**
 * 给 Recently 视图更新 `last_accessed_at`，行存在返回 `true`。
 *
 * **不动 `updated_at`** —— 看一眼不算编辑。
 */
export function touchAccessed(sqlite: BetterSqlite3.Database, postId: number): boolean {
  return (
    sqlite
      .prepare('UPDATE posts SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(postId).changes > 0
  )
}

/** post 是否存在。 */
export function postExists(sqlite: BetterSqlite3.Database, postId: number): boolean {
  return sqlite.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId) !== undefined
}

/**
 * 删除 post 及其全部从属行，返回被删掉的相对文件路径。
 *
 * `ON DELETE CASCADE`（0001_initial.sql 里声明的）负责 `post_has_color` /
 * `post_waifu_scores`。`post_vectors_siglip2` 是 vec0 虚表，不参与外键级联，
 * 必须显式清。`post_has_tag` 也显式删、而且**排在 posts 行前面** —— 这样
 * canonical 感知的 `tags.post_count` 触发器（migration 0009）看到的是每个 post
 * 真实的 canonical 状态，而不是和外键级联抢跑。
 *
 * 分块，于是调用方可以传任意多个 id 而不撞上 SQLite 的绑定参数上限；每块的
 * DELETE 在一个事务里，被中断也不会留下一个活着但被剥了标签和向量的 post。同一个
 * 事务里还把引用这些 post 的未完成标注队列项标成完成（`closeQueueItemsFor`）。
 *
 * 文件不在这里删 —— 返回路径由调用方处理，因为 target_dir 是 API 层的知识。
 */
export function deleteManyReturningPaths(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): string[] {
  if (!ids.length)
    return []
  const fullPaths: string[] = []
  // vec0 上的 `post_id IN (...)` 是全表扫（见 `vectors.ts` 文件头），逐 id 点删。
  const delVector = sqlite.prepare(`DELETE FROM ${SIGLIP2_TABLE} WHERE post_id = ?`)

  for (const chunk of chunked(ids, DELETE_CHUNK)) {
    const ph = placeholders(chunk.length)
    sqlite.transaction(() => {
      // 删行之前先把文件路径收集起来
      for (const row of sqlite
        .prepare<unknown[], { full_path: string }>(`SELECT full_path FROM posts WHERE id IN (${ph})`)
        .all(...chunk))
        fullPaths.push(row.full_path)
      // vec0 虚表 —— 没有外键级联。⚠️ 排在 post_has_tag 之前：那条 DELETE 弄脏的页会
      // 占满默认页缓存（~2 MB），之后 vec0 每删一行都要重读 4.7 MB 的向量分块 blob ——
      // 真库副本上 500 条点删从 35 ms 变成 2.4–4.5 s。顺序对结果没有影响。
      for (const id of chunk)
        delVector.run(id)
      // 显式且排在 posts 之前，好让 trg_post_has_tag_count_ad 在 post 行还在时触发
      sqlite.prepare(`DELETE FROM post_has_tag WHERE post_id IN (${ph})`).run(...chunk)
      closeQueueItemsFor(sqlite, chunk)
      sqlite.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...chunk)
    })()
  }
  return fullPaths
}

/** `deleteManyReturningPaths` 每块的大小（一块一个事务）；`post-files.ts` 按同一大小切，于是每次调用恰好一个事务。 */
export const DELETE_CHUNK = 500

/**
 * 把引用到这些 post 的**未完成**标注队列项标成完成。
 *
 * 队列项表对 posts 没有外键（0011 / 0016），post 删了它们还在：`nextAbsoluteItems` /
 * `nextPairwiseItems` 是 JOIN posts 取的，于是这些项永远取不出来，也永远不会被标完 ——
 * 进度条卡在 `done < total`。标成 done 让进度对得上；不删，`total` 也就不变。
 * 标注事件表（absolute/pairwise/listwise_annotations）不动：训练标注删不删由用户决定。
 *
 * listwise 项**不在这里关**：组里删掉一张不等于这组不能排了。取件时
 * （`nextPresentableListwiseItems`）按剩余成员数判定，不足 `MIN_PRESENTABLE_GROUP`
 * 才跳过并标完成 —— 两处各有一套规则会互相矛盾，而这里每块还要全扫一遍 json_each。
 */
function closeQueueItemsFor(sqlite: BetterSqlite3.Database, ids: number[]): void {
  const ph = placeholders(ids.length)
  sqlite.prepare(`UPDATE absolute_queue_items SET done = 1 WHERE done = 0 AND post_id IN (${ph})`).run(...ids)
  sqlite.prepare(`UPDATE pairwise_queue_items SET done = 1 WHERE done = 0 AND post_a IN (${ph})`).run(...ids)
  sqlite.prepare(`UPDATE pairwise_queue_items SET done = 1 WHERE done = 0 AND post_b IN (${ph})`).run(...ids)
}

/**
 * 直接存在 `folder` 或其任意子目录下的 post id。
 *
 * 精确前缀语义（`folder` 或 `folder/...`）：范围比较恰好抓住以 `folder/` 开头的
 * 路径（'0' 是 '/' 的下一个码位），永远不会捎上只是共享名字前缀的兄弟目录
 * （`art` vs `art2`），而且 —— 不像 GLOB —— 对目录名里的 `[ ] * ?` 免疫。
 */
export function listIdsInFolder(sqlite: BetterSqlite3.Database, folder: string): number[] {
  return sqlite
    .prepare<[string, string, string], { id: number }>(
      'SELECT id FROM posts WHERE file_path = ? OR (file_path >= ? AND file_path < ?) ORDER BY id',
    )
    .all(folder, `${folder}/`, `${folder}0`)
    .map(r => r.id)
}

/**
 * 旋转之后要一起改的那几列。
 *
 * `arthash` 是 `string | null`，而这里直接 `SET arthash = ?`（不是 COALESCE）。写进
 * NULL 就是一条新的 basics 待办，而这张图的 id 在待办查询的水位线**以下** —— 不喊的话
 * 它的 arthash 永远补不回来（见 `../repending.ts`）。`sha256` 写成空串同理。只在真写空
 * 时喊，免得每次旋转都逼 basics 全库重扫一轮。
 */
export function updateForRotate(
  sqlite: BetterSqlite3.Database,
  postId: number,
  v: { sha256: string, size: number, width: number, height: number, arthash: string | null },
): void {
  const info = sqlite
    .prepare(
      'UPDATE posts SET sha256 = ?, size = ?, width = ?, height = ?, arthash = ?, '
      + 'updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .run(v.sha256, v.size, v.width, v.height, v.arthash, postId)
  if (info.changes && (!v.arthash || !v.sha256))
    notifyRepending(sqlite, 'basics', postId)
}

/**
 * 建一个只有路径三元组和 source 的 post，返回新 id。
 *
 * 上传路径用它 —— 其余每一列都吃 schema 默认值，交给 backfill 去填。
 */
export function createPost(
  sqlite: BetterSqlite3.Database,
  v: { filePath: string, fileName: string, extension: string, source?: string },
): number {
  const info = sqlite
    .prepare('INSERT INTO posts(file_path, file_name, extension, source) VALUES (?, ?, ?, ?)')
    .run(v.filePath, v.fileName, v.extension, v.source ?? '')
  const id = Number(info.lastInsertRowid)
  // 新行等 backfill 去填：叫醒空转的循环（见 `../repending.ts`）。
  notifyRepending(sqlite, BACKFILL_WORKERS, id)
  return id
}

/**
 * "看起来是一张图"认的扩展名。
 *
 * ⚠️ 比 `backfill.ts` 的 `IMAGE_EXTS` **宽**（多了 bmp/tiff/tif/svg），两者不能合并：
 * 那一个决定"backfill 要不要碰它"，这一个决定"端点返不返 400"。把 svg 塞进 backfill
 * 会让每一轮都去解码一个模型读不了的文件；而这里收窄则会让一张 bmp 从 400 变成
 * 一次真实计算 —— 都是可见的行为漂移。
 */
export const IS_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg']

/** 路径看起来是不是一张图（大小写不敏感的后缀判断）。`/v2/cmd/*` 的单张命令拿它判 400。 */
export function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return IS_IMAGE_EXTS.some(ext => lower.endsWith(`.${ext}`))
}

export interface PostPath {
  id: number
  /** 相对 `target_dir` 的路径（`full_path` 生成列）。绝对路径由 API 层的 `postAbsPath` 拼。 */
  fullPath: string
}

/** 单张图的 id + 相对路径；不存在返回 `null`（端点据此给 404）。 */
export function getPostPath(
  sqlite: BetterSqlite3.Database,
  postId: number,
): PostPath | null {
  const row = sqlite
    .prepare<[number], { id: number, full_path: string }>(
      'SELECT id, full_path FROM posts WHERE id = ?',
    )
    .get(postId)
  return row ? { id: row.id, fullPath: row.full_path } : null
}

/** `(相对目录, 文件名主干, 扩展名)` —— posts 行在磁盘上的身份，sync 对账的键。 */
export type PostTriple = [filePath: string, fileName: string, extension: string]

/** `listPostTriples` 的一行 —— 原样的列名，不做 camelCase 转换。 */
export interface PostTripleRow {
  id: number
  file_path: string
  file_name: string
  extension: string
}

/**
 * 全库每一行的 id 和路径三元组。sync 对账拿它和磁盘求差。
 *
 * 原样返回驱动给的行：全库十几万行，每次对账再逐行拷成 camelCase 对象纯属白分配。
 */
export function listPostTriples(sqlite: BetterSqlite3.Database): PostTripleRow[] {
  return sqlite
    .prepare<[], PostTripleRow>('SELECT id, file_path, file_name, extension FROM posts')
    .all()
}

/**
 * 按路径三元组批量建行（一个事务），其余列吃 schema 默认值、等 backfill 去填。
 *
 * 新行的 id 在每条待办水位线**之上**，信号只是把空转的循环叫醒（见 `../repending.ts`）。
 */
export function insertPostTriples(sqlite: BetterSqlite3.Database, triples: readonly PostTriple[]): void {
  if (!triples.length)
    return
  // OR IGNORE：sync 的快照和并发写入（上传端点）之间，同一个文件可能已经被别人登记了。
  // 唯一索引会挡住重复行，但普通 INSERT 撞上它会让整批回滚，这一轮的其余新文件跟着丢。
  const ins = sqlite.prepare('INSERT OR IGNORE INTO posts(file_path, file_name, extension) VALUES (?, ?, ?)')
  const firstId = sqlite.transaction(() => {
    let first: number | undefined
    for (const t of triples) {
      const r = ins.run(t[0], t[1], t[2])
      if (r.changes)
        first ??= Number(r.lastInsertRowid)
    }
    return first
  })()
  if (firstId !== undefined)
    notifyRepending(sqlite, BACKFILL_WORKERS, firstId)
}
