/**
 * 用差分组把 listwise 标注扩成训练数据。
 *
 * 依据不是"差分看起来差不多"这种直觉，而是标注行为本身：`pairwise_annotations` 里
 * 两侧属于同一差分组的 49 条判决中，**46 条判了平局（94%）**，而跨组对的平局率只有
 * 22%；同组对的决策耗时中位数 1165 ms，跨组是 2192 ms —— 一眼就看出"这俩一样"，
 * 没有犹豫。既然人在比较里把它们当成可互换的，那么一条排序里的某张图换成同组的另一
 * 张，人给出的排序应当不变。
 *
 * 反过来还有一层收益：模型现在**做不到**这一点。同组两张图的 silva 分在全库百分位上
 * p90 差 14 个百分点、p99 差 34 个（waifu 更差，p99 差 50 个），而人说它们等价。所以
 * 这份扩充不只是"更多数据"，它教的正是模型缺的那条不变性。
 *
 * ⚠️ **展开出来的样本不是独立样本。** 同一条标注的所有变体共享同一个人类判决，信息量
 * 仍然约等于一条。按变体数随机划分训练/验证集会让同一条标注的变体分落两边，验证集
 * 泄漏、指标虚高而模型没变好。每条输出都带着 `annotationId`，划分必须按它分组
 * （GroupKFold 那种），扩充只在训练侧展开。这不是建议，是这份数据的使用前提。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { placeholders } from '../sql.js'

/** 一条展开后的排序。`variant` 0 恒为原始标注本身。 */
export interface ExpandedListwise {
  /** 来源标注 id —— 划分数据集时必须按它分组，见文件头注释。 */
  annotationId: number
  variant: number
  dimension: string
  rubricVersion: string
  /** 从好到差，与原标注的 `ranking` 同序、等长。 */
  ranking: number[]
  /** 这个变体替换了哪些位置。`variant` 0 时为空。 */
  substitutions: Array<{ from: number, to: number, lpips: number | null }>
}

export interface ExpandOptions {
  /**
   * 一个位置最多几个候选（**含原图**）。默认 3。
   *
   * 候选按 LPIPS 距离升序取 —— 最像原图的先用。设 1 等于关掉扩充。
   */
  maxCandidatesPerSlot?: number
  /** 一条标注最多展开成几个变体（含原始那条）。默认 8。 */
  maxVariantsPerAnnotation?: number
  /**
   * 替身与原图的 LPIPS 距离上限。默认不限（用分组时的阈值）。
   *
   * 收紧它是最直接的保守手段：分组是靠传递闭包成的，同组两张图之间不一定有直接边，
   * 更不一定近。只想用"肉眼几乎同一张"的替身时把它压到 0.2 附近。
   */
  maxLpips?: number
}

interface RawAnnotation {
  id: number
  post_ids: string
  ranking: string
  dimension: string
  rubric_version: string
}

/**
 * 从混合基数的笛卡尔积里**均匀**取至多 `limit` 个组合，第 0 个恒为全原图。
 *
 * 纯函数，独立于数据库。均匀而不是"取前 N 个"：按字典序取前 N 会让变化全部堆在最后
 * 一个位置上（其余位置永远是原图），扩出来的数据只覆盖了一个角落。
 */
export function pickCombinations(sizes: readonly number[], limit: number): number[][] {
  if (sizes.length === 0 || limit < 1)
    return []
  let total = 1
  for (const n of sizes)
    total *= Math.max(1, n)
  const take = Math.min(total, limit)
  const stride = Math.max(1, Math.floor(total / take))

  const out: number[][] = []
  for (let k = 0; k < take; k++) {
    let rest = (k * stride) % total
    const combo: number[] = []
    for (const n of sizes) {
      const base = Math.max(1, n)
      combo.push(rest % base)
      rest = Math.floor(rest / base)
    }
    out.push(combo)
  }
  // 第 0 个组合恒为全 0（原图）—— k=0 时 rest=0。stride 的取整可能让某个组合重复，
  // 去重后仍然保证原始那条在最前。
  const seen = new Set<string>()
  return out.filter((combo) => {
    const key = combo.join(',')
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

/** 每个 post 所在差分组的其它成员，按与它的 LPIPS 距离升序。 */
function substitutesFor(
  sqlite: BetterSqlite3.Database,
  postIds: readonly number[],
  maxLpips: number | undefined,
): Map<number, Array<{ id: number, lpips: number | null }>> {
  const out = new Map<number, Array<{ id: number, lpips: number | null }>>()
  if (postIds.length === 0)
    return out

  const list = [...new Set(postIds)]
  // 一条 SQL 拿到"这些 post 所在组的全部成员"外加这一对的直接距离：先解析出每个
  // post 的组代表（canonical_post_id 为空时它自己就是代表），再取所有指向该代表的
  // 成员，最后 LEFT JOIN 证据表。表上有 CHECK (post_a < post_b)，所以 (min, max)
  // 那一侧就是全部可能的匹配。
  const rows = sqlite
    .prepare<number[], { seed: number, member: number, lpips_dist: number | null }>(
      `WITH seeds AS (
         SELECT id AS seed, COALESCE(canonical_post_id, id) AS head
         FROM posts WHERE id IN (${placeholders(list.length)})
       )
       SELECT s.seed, p.id AS member, e.lpips_dist
       FROM seeds s
       JOIN posts p ON p.id = s.head OR p.canonical_post_id = s.head
       LEFT JOIN post_variant_edges e
         ON e.post_a = MIN(s.seed, p.id) AND e.post_b = MAX(s.seed, p.id)
       WHERE p.id != s.seed`,
    )
    .all(...list)

  for (const row of rows) {
    // 同组不代表有直接边（传递闭包），拿不到距离就是 null —— 那种替身排在最后，
    // 而且会被 maxLpips 过滤掉。
    const lpips = row.lpips_dist
    if (maxLpips != null && (lpips == null || lpips > maxLpips))
      continue
    const bucket = out.get(row.seed)
    if (bucket)
      bucket.push({ id: row.member, lpips })
    else out.set(row.seed, [{ id: row.member, lpips }])
  }
  for (const bucket of out.values()) {
    bucket.sort((x, y) =>
      (x.lpips ?? Number.POSITIVE_INFINITY) - (y.lpips ?? Number.POSITIVE_INFINITY) || x.id - y.id)
  }
  return out
}

/**
 * 展开全部 listwise 标注。
 *
 * 顺序是确定的（按标注 id、再按变体序），所以同样的库和参数每次导出逐行相同 ——
 * 训练集能复现，diff 也读得懂。
 */
export function expandListwiseAnnotations(
  sqlite: BetterSqlite3.Database,
  options: ExpandOptions = {},
): ExpandedListwise[] {
  const perSlot = Math.max(1, options.maxCandidatesPerSlot ?? 3)
  const perAnnotation = Math.max(1, options.maxVariantsPerAnnotation ?? 8)

  const annotations = sqlite
    .prepare<[], RawAnnotation>(
      `SELECT id, post_ids, ranking, dimension, rubric_version
       FROM listwise_annotations ORDER BY id`,
    )
    .all()
  if (annotations.length === 0)
    return []

  const everyPost = new Set<number>()
  const rankings = new Map<number, number[]>()
  for (const row of annotations) {
    const ranking = JSON.parse(row.ranking) as number[]
    rankings.set(row.id, ranking)
    for (const id of ranking)
      everyPost.add(id)
  }
  const subs = substitutesFor(sqlite, [...everyPost], options.maxLpips)

  const out: ExpandedListwise[] = []
  for (const row of annotations) {
    const ranking = rankings.get(row.id)!
    // 每个位置的候选：原图打头，然后是最像的几个替身。
    const slots = ranking.map(id => [
      { id, lpips: null as number | null },
      ...(subs.get(id) ?? []).slice(0, perSlot - 1),
    ])
    const combos = pickCombinations(slots.map(s => s.length), perAnnotation)
    for (const [variant, combo] of combos.entries()) {
      const substitutions: ExpandedListwise['substitutions'] = []
      const expanded = combo.map((choice, slot) => {
        const picked = slots[slot]![choice]!
        if (choice !== 0)
          substitutions.push({ from: ranking[slot]!, to: picked.id, lpips: picked.lpips })
        return picked.id
      })
      // 同一张图在一条排序里出现两次是无意义的样本（两个位置的替身撞车了）。
      // 只筛替换出来的变体：variant 0 是人给的原始输入，即便它自己有毛病也照原样
      // 交出去，由使用方判断 —— 悄悄删掉一条人类标注是更糟的事。
      if (variant !== 0 && new Set(expanded).size !== expanded.length)
        continue
      out.push({
        annotationId: row.id,
        variant,
        dimension: row.dimension,
        rubricVersion: row.rubric_version,
        ranking: expanded,
        substitutions,
      })
    }
  }
  return out
}
