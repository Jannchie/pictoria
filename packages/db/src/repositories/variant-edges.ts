/**
 * 差分证据表的读写 —— 一对 post 之间"是不是同一张画"的度量与裁决（migration 0019）。
 *
 * 这张表存的是**原始距离**，不是判定。"lpips 小于多少算同一张"是调用方的阈值
 * （`LPIPS_SAME_THRESHOLD`），所以调阈值不需要重算任何一对 —— 而重算一遍是几十
 * 分钟的 CPU。同理 `siglip_dist` 也留着：它既是 union-find 的边强度，也是人工抽查
 * "这一对当初为什么会进灰带"的唯一答案。
 *
 * 用户裁决和自动结果共用一行，靠 `user_verdict` 是否为空区分。自动写入永远带
 * `WHERE user_verdict IS NULL`，所以重建不会覆盖任何人的决定 —— 和 0018 的
 * `post_group_overrides` 是同一条原则的两半。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { placeholders } from '../sql.js'

/** 一对 post 的全部证据。`postA < postB` 恒成立（SQL 侧有 CHECK）。 */
export interface VariantEdgeRow {
  postA: number
  postB: number
  siglipDist: number | null
  lpipsDist: number | null
  userVerdict: 'same' | 'different' | null
}

/** 一次自动写入：召回给出 `siglipDist`，仲裁给出 `lpipsDist`（还没仲裁则为 null）。 */
export interface AutoEdge {
  postA: number
  postB: number
  siglipDist: number | null
  lpipsDist: number | null
}

/** `post_variant_edges` 的列名与行形状 —— 两个读函数共用，加一列证据只改这里。 */
const EDGE_COLS = 'post_a, post_b, siglip_dist, lpips_dist, user_verdict'

interface EdgeSqlRow {
  post_a: number
  post_b: number
  siglip_dist: number | null
  lpips_dist: number | null
  user_verdict: 'same' | 'different' | null
}

function toEdge(row: EdgeSqlRow): VariantEdgeRow {
  return {
    postA: row.post_a,
    postB: row.post_b,
    siglipDist: row.siglip_dist,
    lpipsDist: row.lpips_dist,
    userVerdict: row.user_verdict,
  }
}

/**
 * 一次 IN 查询塞多少个 id。
 *
 * SQLite 的变量上限在新版本是 32766，但 900 是这个仓库里别处已经在用的保守值，
 * 而这里的查询次数（唯一 post_a 数 / 900，全库约 190 次）根本不是瓶颈。
 */
const CHUNK = 900

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK)
    yield items.slice(i, i + CHUNK)
}

/** `(a, b)` 规整成 `a < b` —— 表里一对只有一行，方向没有意义。 */
export function orderPair(x: number, y: number): [number, number] {
  return x < y ? [x, y] : [y, x]
}

/** Map 的键。字符串而不是嵌套 Map：一次重建要查几百万次，扁平的哈希更省。 */
export function edgeKey(a: number, b: number): string {
  const [lo, hi] = orderPair(a, b)
  return `${lo}:${hi}`
}

/**
 * 读出这些 post 作为 `post_a` 的全部边，按 `edgeKey` 索引。
 *
 * 为什么按 `post_a` 整行取，而不是按 `(a, b)` 逐对查：灰带的对是**按行**产生的
 * （每行最多留 K 个最近邻），所以一个 post_a 的边最多 K 条，整行取一次就够，
 * 查询次数从「对数 / 450」降到「唯一 post_a 数 / 900」—— 全库差着两个数量级。
 */
export function readEdgesByLeft(
  sqlite: BetterSqlite3.Database,
  leftIds: readonly number[],
): Map<string, VariantEdgeRow> {
  const out = new Map<string, VariantEdgeRow>()
  if (leftIds.length === 0)
    return out

  for (const batch of chunks(leftIds)) {
    const rows = sqlite
      .prepare<number[], EdgeSqlRow>(
        `SELECT ${EDGE_COLS} FROM post_variant_edges WHERE post_a IN (${placeholders(batch.length)})`,
      )
      .all(...batch)
    for (const row of rows)
      out.set(edgeKey(row.post_a, row.post_b), toEdge(row))
  }
  return out
}

/** 一个 post 参与的所有边 —— 它可能在任意一侧，所以两边都要查（`ix_variant_edges_b`）。 */
export function listEdgesFor(
  sqlite: BetterSqlite3.Database,
  postId: number,
): VariantEdgeRow[] {
  return sqlite
    .prepare<[number, number], EdgeSqlRow>(
      `SELECT ${EDGE_COLS} FROM post_variant_edges WHERE post_a = ? OR post_b = ?`,
    )
    .all(postId, postId)
    .map(toEdge)
}

function livePosts(sqlite: BetterSqlite3.Database, ids: readonly number[]): Set<number> {
  const live = new Set<number>()
  for (const batch of chunks(ids)) {
    const rows = sqlite
      .prepare<number[], { id: number }>(
        `SELECT id FROM posts WHERE id IN (${placeholders(batch.length)})`,
      )
      .all(...batch)
    for (const row of rows)
      live.add(row.id)
  }
  return live
}

/**
 * 写入一批自动算出来的边，返回实际写进去的条数。
 *
 * 两处"不写"都是有意的：
 *
 * * `WHERE user_verdict IS NULL` —— 用户裁决过的那一行只更新度量是没有意义的，
 *   而覆盖掉裁决是有害的，所以整行跳过。
 * * 存活过滤 —— 从导出向量到仲裁结果回来隔着几十分钟，期间被删掉的 post 会让
 *   `REFERENCES posts(id)` 抛异常，整个事务连同这一批算好的距离一起回滚。同
 *   `upsertVectors` / `replaceAllGroups` 的处理。
 */
export function upsertAutoEdges(
  sqlite: BetterSqlite3.Database,
  edges: readonly AutoEdge[],
): number {
  if (edges.length === 0)
    return 0

  const involved = new Set<number>()
  for (const edge of edges) {
    involved.add(edge.postA)
    involved.add(edge.postB)
  }

  const insert = sqlite.prepare(
    `INSERT INTO post_variant_edges (post_a, post_b, siglip_dist, lpips_dist, computed_at) `
    + `VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) `
    + `ON CONFLICT(post_a, post_b) DO UPDATE SET `
    + `siglip_dist = COALESCE(excluded.siglip_dist, post_variant_edges.siglip_dist), `
    + `lpips_dist = COALESCE(excluded.lpips_dist, post_variant_edges.lpips_dist), `
    + `computed_at = CURRENT_TIMESTAMP `
    + `WHERE post_variant_edges.user_verdict IS NULL`,
  )

  return sqlite.transaction(() => {
    const live = livePosts(sqlite, [...involved])
    let written = 0
    for (const edge of edges) {
      const [lo, hi] = orderPair(edge.postA, edge.postB)
      if (lo === hi || !live.has(lo) || !live.has(hi))
        continue
      // COALESCE 而不是直接覆盖：召回那一轮写的是 siglip_dist、lpips_dist 为空，
      // 仲裁回来那一轮反过来。直接覆盖会让后写的一方把前一方的值抹成 null。
      // 距离本身与方向无关，所以规整 (lo, hi) 不影响这两个值。
      insert.run(lo, hi, edge.siglipDist, edge.lpipsDist)
      written += 1
    }
    return written
  })()
}

/**
 * 记下用户对一对 post 的裁决。
 *
 * `decided_at` 一起写，因为"什么时候决定的"是这张表里唯一有审计价值的东西 ——
 * 一个用户回头看"我当初为什么把这两张分开"时，时间是他能对上号的线索。
 */
export function setUserVerdict(
  sqlite: BetterSqlite3.Database,
  postX: number,
  postY: number,
  verdict: 'same' | 'different',
): void {
  const [lo, hi] = orderPair(postX, postY)
  if (lo === hi)
    return
  sqlite
    .prepare(
      `INSERT INTO post_variant_edges (post_a, post_b, user_verdict, decided_at) `
      + `VALUES (?, ?, ?, CURRENT_TIMESTAMP) `
      + `ON CONFLICT(post_a, post_b) DO UPDATE SET `
      + `user_verdict = excluded.user_verdict, decided_at = CURRENT_TIMESTAMP`,
    )
    .run(lo, hi, verdict)
}

/** 读出全部用户裁决 —— 重建时它们是硬约束，而它们的数量是"用户点过多少次"。 */
export function listUserVerdicts(
  sqlite: BetterSqlite3.Database,
): Array<{ postA: number, postB: number, verdict: 'same' | 'different' }> {
  return sqlite
    .prepare<[], { post_a: number, post_b: number, user_verdict: 'same' | 'different' }>(
      `SELECT post_a, post_b, user_verdict FROM post_variant_edges WHERE user_verdict IS NOT NULL`,
    )
    .all()
    .map(row => ({ postA: row.post_a, postB: row.post_b, verdict: row.user_verdict }))
}

/**
 * 这些 post 的 `full_path`（相对图库根），用来拼缩略图路径。
 *
 * 放在这里而不是 `posts.ts`：它唯一的调用者是仲裁那一步 —— 灰带里的对要变成
 * worker 能打开的两个文件。返回 Map 而不是数组，因为调用方拿到的是一堆 id 的
 * 集合而不是一个有序列表，而缺失（post 刚被删）要能被看出来。
 */
export function listFullPaths(
  sqlite: BetterSqlite3.Database,
  ids: readonly number[],
): Map<number, string> {
  const out = new Map<number, string>()
  for (const batch of chunks(ids)) {
    const rows = sqlite
      .prepare<number[], { id: number, full_path: string }>(
        `SELECT id, full_path FROM posts WHERE id IN (${placeholders(batch.length)})`,
      )
      .all(...batch)
    for (const row of rows)
      out.set(row.id, row.full_path)
  }
  return out
}
