/**
 * posts 表的写操作 —— 形状承自已退役的 Python 侧 `db/repositories/posts.py`。
 */
import { placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { BULK_UPDATABLE_FIELDS, UPDATABLE_FIELDS } from '../filters.js'
import { setUserVerdict } from './variant-edges.js'
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
  let matched = false
  sqlite.transaction(() => {
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
  sqlite.transaction(() => {
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
 * 解组：把这些 id 提回独立的 canonical post，并记下"用户拆的"。
 *
 * 光清指针活不过下一次重建 —— `replaceAllGroups` 清空全部指针再按边重算，几分钟后
 * 的 embedding 回填排空就会把这几张图原样合回去。所以同一个事务里再写一条
 * `post_group_overrides(kind='standalone')`，让重建绕开它们（migration 0018）。
 *
 * 一个事务：指针清了而意图没落库，就等于什么都没做，只是要过几分钟才看得出来。
 *
 * UPSERT 而不是 INSERT OR IGNORE —— 之前被钉成封面的 post 现在被拆出来，kind 要
 * 跟着改（两种意图互斥），`created_at` 也刷新成这一次决定的时间。
 */
export function clearCanonical(sqlite: BetterSqlite3.Database, ids: number[]): void {
  if (!ids.length)
    return
  const clear = sqlite.prepare(
    `UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP `
    + `WHERE id IN (${placeholders(ids.length)})`,
  )
  // `SELECT id FROM posts` 而不是 `VALUES (?)`：清指针对已删的 id 本来就是匹配
  // 0 行的空操作，意图行不能反过来拿外键把整个调用炸掉。
  const remember = sqlite.prepare(
    `INSERT INTO post_group_overrides (post_id, kind) `
    + `SELECT id, 'standalone' FROM posts WHERE id = ? `
    + `ON CONFLICT(post_id) DO UPDATE SET kind = 'standalone', created_at = CURRENT_TIMESTAMP`,
  )
  sqlite.transaction(() => {
    clear.run(...ids)
    for (const id of ids) remember.run(id)
  })()
}

/**
 * 把 `head` 钉成它那一组的封面（0018 的 `canonical` override），并撤掉同组其它成员
 * 上的旧 pin —— 一个组只能钉一个封面。
 *
 * **必须在指针写完之后调用**：它靠 `canonical_post_id = head` 找"同组其它成员"，
 * 在 repoint/attach 之前那句查不到任何东西。
 */
function pinCanonical(sqlite: BetterSqlite3.Database, head: number): void {
  sqlite
    .prepare(
      `DELETE FROM post_group_overrides WHERE kind = 'canonical' AND post_id != ? `
      + `AND post_id IN (SELECT id FROM posts WHERE canonical_post_id = ?)`,
    )
    .run(head, head)
  sqlite
    .prepare(
      `INSERT INTO post_group_overrides (post_id, kind) VALUES (?, 'canonical') `
      + `ON CONFLICT(post_id) DO UPDATE SET kind = 'canonical', created_at = CURRENT_TIMESTAMP`,
    )
    .run(head)
}

/**
 * 这个 post 所在差分组的代表；它自己就是代表（或不在任何组里）时返回它自己。
 * post 不存在时返回 null。
 *
 * 存在的理由是一类反复出现的错误：拿 `canonical_post_id` 直接做判断，而忘了查询
 * 对象本身可能**是**一个成员。那样写出来的过滤对代表有效、对成员失效，症状是不
 * 对称而不是报错 —— 相似搜索里从成员搜会看到自己的代表排在第一位，从代表搜却
 * 干干净净。先解析到组代表再判断，是这一类逻辑唯一正确的起手式。
 */
export function groupHeadOf(sqlite: BetterSqlite3.Database, postId: number): number | null {
  const row = sqlite
    .prepare<[number], { head: number }>(
      'SELECT COALESCE(canonical_post_id, id) AS head FROM posts WHERE id = ?',
    )
    .get(postId)
  return row ? Number(row.head) : null
}

/**
 * 把 `postId` 提升为它所在组的 canonical（"设为封面"）。
 *
 * 把原 canonical 和所有兄弟成员重新指向 `postId`，再清掉 `postId` 自己的指针。
 * post 不存在或本来就是 canonical 时是空操作（返回 false）。
 *
 * 一个事务：两条 UPDATE 之间，这个组是个 2-环 —— **每个**成员（含原 canonical）
 * 的指针都非 NULL，也就是整组从列表里消失。被打断不能把那个状态冻住，WAL 读者
 * 也绝不能观察到它。
 *
 * 同一个事务里还要记下"用户钉的封面"（`post_group_overrides(kind='canonical')`，
 * migration 0018）：否则下一次重建按"组内最小 id"重选代表，把这次提升顶掉。
 * 同时清掉**同组其它成员**的 canonical 行 —— 一个组只能钉一个封面，留着旧的会让
 * 重建在两个 pinned 之间按 min id 二选一，选中的那个未必是用户最后点的那个。
 */
export function makeCanonical(sqlite: BetterSqlite3.Database, postId: number): boolean {
  const row = sqlite
    .prepare<[number], { canonical_post_id: number | null }>(
      'SELECT canonical_post_id FROM posts WHERE id = ?',
    )
    .get(postId)
  if (!row || row.canonical_post_id === null)
    return false
  const current = row.canonical_post_id

  const repoint = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE (id = ? OR canonical_post_id = ?) AND id != ?',
  )
  const promote = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  sqlite.transaction(() => {
    repoint.run(postId, current, current, postId)
    promote.run(postId)
    // 排在 repoint 之后：那时整组（含原 canonical）都已经指向 postId。
    pinCanonical(sqlite, postId)
  })()
  return true
}

/**
 * 重建要让路的那些手动决定，一次读完。
 *
 * 重建是全库一次性的，逐个 post 查 override 就是几十万次点查；这张表只有用户点过的
 * 那几条，整张读进内存比什么都便宜。
 */
export function listGroupOverrides(
  sqlite: BetterSqlite3.Database,
): { standalone: Set<number>, canonical: Set<number> } {
  const standalone = new Set<number>()
  const canonical = new Set<number>()
  for (const row of sqlite
    .prepare<[], { post_id: number, kind: string }>(
      'SELECT post_id, kind FROM post_group_overrides',
    )
    .all()) {
    if (row.kind === 'standalone')
      standalone.add(row.post_id)
    else canonical.add(row.post_id)
  }
  return { standalone, canonical }
}

/** `posts` 里这些 id 的存活情况与当前组指针，一次读完。 */
function readPointers(
  sqlite: BetterSqlite3.Database,
  ids: readonly number[],
): Map<number, number | null> {
  const rows = sqlite
    .prepare<number[], { id: number, canonical_post_id: number | null }>(
      `SELECT id, canonical_post_id FROM posts WHERE id IN (${placeholders(ids.length)})`,
    )
    .all(...ids)
  return new Map(rows.map(r => [r.id, r.canonical_post_id]))
}

/**
 * 把若干 post 手动合成一个近重复组（"这些是同一张画的差分"）。
 *
 * 三件事必须在同一个事务里，因为它们各自单独都不足以让这次合并活下来：
 *
 * 1. 指针 —— 立刻可见的那一半：非 canonical 的成员指向 canonical。
 * 2. `user_verdict='same'` 边 —— 活过重建的那一半。重建（`replaceAllGroups`）清空
 *    全部指针再按边重算，用户裁决过的边以最高强度强制成组（dedup.ts 读
 *    `listUserVerdicts`）。只写指针的话这次合并的寿命是几分钟。
 * 3. 删掉这些 id 的 `standalone` override —— 用户以前把某张拆出来过，那条意图会让
 *    重建继续绕开它，于是重建之后这张图又从组里掉出来。两种意图互斥，新的覆盖旧的。
 *
 * 边是**星形**（canonical 与其余每一个）而不是全连接：union-find 下星形已经能把整组
 * 连通，而 n 张图的全连接是 O(n²) 行用户裁决 —— 那些用户从没看过的对会被写成"用户
 * 决定过"，之后既挡住自动仲裁，也会出现在详情面板的 pin 角标里。
 *
 * canonical 的解析顺序：显式传入 > 某个 id 已属于的那个组的 canonical > ids 里最小的。
 * 中间那一条是为了"往已有组里再拖两张进来"不会把原组的封面顶掉。
 *
 * 少于 2 个（去重后）id、或任何一个 id 不存在时返回 false —— 不存在的 id 会让
 * `post_variant_edges` 的外键把整个调用炸掉，提前查一次比让调用方去解析异常便宜。
 */
export function groupTogether(
  sqlite: BetterSqlite3.Database,
  ids: number[],
  canonicalId?: number,
): boolean {
  const members = [...new Set(ids)].filter(id => Number.isInteger(id))
  if (members.length < 2)
    return false

  // 显式指定的 canonical 可以在 ids 之外（"把这两张并进那个组"），但同样要存在。
  const wanted = canonicalId != null && !members.includes(canonicalId)
    ? [...members, canonicalId]
    : members
  const pointers = readPointers(sqlite, wanted)
  if (pointers.size !== wanted.length)
    return false

  let head: number
  if (canonicalId != null) {
    head = canonicalId
  }
  else {
    // 按 id 升序找第一个已经属于某组的成员，沿用它的 canonical —— 遍历顺序固定，
    // 否则同一批 id 换个顺序传进来会得到不同的封面。
    const sorted = [...members].sort((a, b) => a - b)
    head = sorted.map(id => pointers.get(id) ?? null).find(v => v != null) ?? sorted[0]!
  }
  const rest = members.filter(id => id !== head)
  if (rest.length === 0)
    return false

  const promote = sqlite.prepare(
    'UPDATE posts SET canonical_post_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
  // head 以外的成员里，可能有自己就是别的组的封面的 —— 把它变成成员而不管它的下属，
  // 会留下一条两级指针链（成员 → 成员 → canonical），而全库到处假设指针只有一级。
  const reparent = sqlite.prepare(
    `UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP `
    + `WHERE canonical_post_id IN (${placeholders(rest.length)}) AND id != ?`,
  )
  const attach = sqlite.prepare(
    `UPDATE posts SET canonical_post_id = ?, updated_at = CURRENT_TIMESTAMP `
    + `WHERE id IN (${placeholders(rest.length)})`,
  )
  const unStandalone = sqlite.prepare(
    `DELETE FROM post_group_overrides WHERE kind = 'standalone' `
    + `AND post_id IN (${placeholders(wanted.length)})`,
  )
  // 显式指定封面才 pin，没指定不 pin（见下面事务里的 pinCanonical）。
  //
  // 为什么必须 pin —— `same` 边保证这些图重建后仍在一组，但代表是按"组内最小 id"
  // 重选的，所以用户特意指定的封面会在下一次重建里静默换人。那正是 0018 这张表
  // 存在的理由，只是换了个入口进来。
  //
  // 反过来，没指定封面时**不能**顺手 pin 一个：用户表达的是"这几张是一组"，不是
  // "这张当代表"，替他做了这个决定，以后自动重选一个更早的代表就成了 bug。
  sqlite.transaction(() => {
    promote.run(head)
    reparent.run(head, ...rest, head)
    attach.run(head, ...rest)
    unStandalone.run(...wanted)
    // 排在 attach 之后：那时整组都已经指向 head，"同组其它成员"才查得到。
    if (canonicalId != null)
      pinCanonical(sqlite, head)
    for (const id of rest) setUserVerdict(sqlite, head, id, 'same')
  })()
  return true
}

/**
 * 记下"这两张不是同一张"，并且**立刻**把它们分开。
 *
 * 只写裁决的话，用户点完看不到任何变化 —— 那条边要等下一次重建才会被排除，而重建
 * 是几分钟到几小时之后的事。所以如果这两张此刻同组，同一个事务里把非 canonical 的
 * 那个拆出来（`clearCanonical`，它连 `standalone` override 一起写，于是拆开这件事
 * 也活过重建）。
 *
 * 两张都是同一个组的成员（谁都不是 canonical）时拆 `b`：调用方是详情面板，`a` 是
 * 正在看的那张、`b` 是列表里被点的那一个，拆掉被点的那个才是用户看到的因果。
 *
 * 同一个 id、或任何一个不存在时返回 false（外键理由同 `groupTogether`）。
 */
export function markDifferent(
  sqlite: BetterSqlite3.Database,
  a: number,
  b: number,
): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b)
    return false
  const pointers = readPointers(sqlite, [a, b])
  if (pointers.size !== 2)
    return false

  const ca = pointers.get(a) ?? null
  const cb = pointers.get(b) ?? null
  let victim: number | null = null
  if (cb === a)
    victim = b
  else if (ca === b)
    victim = a
  else if (ca !== null && ca === cb)
    victim = b

  sqlite.transaction(() => {
    setUserVerdict(sqlite, a, b, 'different')
    if (victim !== null)
      clearCanonical(sqlite, [victim])
  })()
  return true
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
 * 分块，于是调用方可以传任意多个 id 而不撞上 SQLite 的绑定参数上限；每块的三条
 * DELETE 在一个事务里，被中断也不会留下一个活着但被剥了标签和向量的 post。
 *
 * 文件不在这里删 —— 返回路径由调用方处理，因为 target_dir 是 API 层的知识。
 */
export function deleteManyReturningPaths(
  sqlite: BetterSqlite3.Database,
  ids: number[],
): string[] {
  if (!ids.length)
    return []
  const CHUNK = 500
  const fullPaths: string[] = []

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const ph = placeholders(chunk.length)
    sqlite.transaction(() => {
      // 删行之前先把文件路径收集起来
      for (const row of sqlite
        .prepare<unknown[], { full_path: string }>(`SELECT full_path FROM posts WHERE id IN (${ph})`)
        .all(...chunk))
        fullPaths.push(row.full_path)
      // 显式且排在 posts 之前，好让 trg_post_has_tag_count_ad 在 post 行还在时触发
      sqlite.prepare(`DELETE FROM post_has_tag WHERE post_id IN (${ph})`).run(...chunk)
      // vec0 虚表 —— 没有外键级联
      sqlite.prepare(`DELETE FROM ${SIGLIP2_TABLE} WHERE post_id IN (${ph})`).run(...chunk)
      sqlite.prepare(`DELETE FROM posts WHERE id IN (${ph})`).run(...chunk)
    })()
  }
  return fullPaths
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

/** 旋转之后要一起改的那几列。 */
export function updateForRotate(
  sqlite: BetterSqlite3.Database,
  postId: number,
  v: { sha256: string, size: number, width: number, height: number, arthash: string | null },
): void {
  sqlite
    .prepare(
      'UPDATE posts SET sha256 = ?, size = ?, width = ?, height = ?, arthash = ?, '
      + 'updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
    .run(v.sha256, v.size, v.width, v.height, v.arthash, postId)
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
  return Number(info.lastInsertRowid)
}
