/**
 * 打分器注册表 —— 形状承自已退役的 Python 侧 `server/src/scorers.py`。
 *
 * ⚠️ 两边是手工同步的双份，没有任何机制校验它们一致。真正跨进程的只有**名字**
 * （`SILVA_SCORERS`，定义在 `@pictoria/contracts`）；join SQL 与分档边界只有这一侧在用。
 *
 * `post_aesthetic_scores` 是通用的 per-(post, scorer) 表；每个住在里面的打分器由
 * 一条 `ScorerSpec` 描述一次：DB 里的 `scorer` 名、join 用的别名、A–E 分档边界、
 * 以及把原生分抬到人工 1–5 星标度的仿射映射。加一个打分器 = 加一条注册项，而不是
 * 到处再抄一遍 LEFT JOIN / CASE。
 *
 * 注意：`post_waifu_scores` 是**独立的遗留单打分器表**，0–10 原生标度、自己的 join
 * 形状，故意不在这个注册表里。
 */

export const AESTHETIC_SCORES_TABLE = 'post_aesthetic_scores'

/** 半开区间 [lo, hi)。 */
export type Buckets = Record<string, readonly [number, number]>

export interface ScorerSpec {
  readonly name: string
  readonly buckets: Buckets
  /** 抬到 1–5 标度：native * scale + offset。 */
  readonly scale: number
  readonly offset: number
  /** SQL 别名，例如 `pas_silva`。 */
  readonly alias: string
  joinSql: (opts?: { alias?: string, tableAlias?: string }) => string
  isJoined: (joins: Iterable<string>) => boolean
  scoreCol: (alias?: string) => string
  nullCol: (alias?: string) => string
  scoreExpr: (alias?: string) => string
}

interface DefineOptions {
  /** 分数所在的表。默认是通用的 `post_aesthetic_scores`。 */
  readonly table?: string
  readonly alias?: string
  readonly scale?: number
  readonly offset?: number
  /**
   * join 是否带 `scorer = '<name>'` 谓词。
   *
   * 只有通用表需要它 —— 一张表里住着多个打分器，不加就把别人的分也 join 进来了。
   * 独占一张表的打分器（waifu）传 false。
   */
  readonly scoped?: boolean
}

/**
 * 返回类型带上字面量 `name`，`FILTERABLE_SCORERS` 才能派生出
 * `'waifu' | 'silva' | 'silva_luna'` 这个联合类型，进而派生出 `PostFilter` 上的
 * `<name>_score_levels` 字段名。收窄成 `string` 的话下游就只能手写字段名了。
 */
function defineScorer<N extends string>(
  name: N,
  buckets: Buckets,
  { table = AESTHETIC_SCORES_TABLE, alias = `pas_${name}`, scale = 4, offset = 1, scoped = true }: DefineOptions = {},
): ScorerSpec & { readonly name: N } {
  return {
    name,
    buckets,
    scale,
    offset,
    alias,
    joinSql: ({ alias: a = alias, tableAlias = 'p' } = {}) =>
      `LEFT JOIN ${table} ${a} ON ${a}.post_id = ${tableAlias}.id${scoped ? ` AND ${a}.scorer = '${name}'` : ''}`,
    /**
     * 别名要按**整词**匹配（空格分隔）。裸子串判断在两个打分器名共享前缀时就会错：
     * `pas_silva` 是 `pas_silva_luna` 的子串，于是对后者的过滤会被误判成前者已 join，
     * 真正的 join 被丢掉，SQL 里留下一个未绑定的别名。
     */
    isJoined: joins => [...joins].some(j => j.includes(` ${alias} `)),
    scoreCol: (a = alias) => `${a}.score`,
    nullCol: (a = alias) => `${a}.post_id`,
    scoreExpr: (a = alias) => `${a}.score * ${scale} + ${offset}`,
  }
}

/**
 * SILVA 原生分域是 [0, 1]，A–E 五档。半开区间 [lo, hi)；'A' 实际是 [0.8, 1.0] ——
 * 上边界由源域保证（分数会 clamp 到 [0, 1]），这里用 1.0001 把闭区间表达出来。
 */
export const SILVA_SCORE_BUCKETS: Buckets = {
  E: [0, 0.2],
  D: [0.2, 0.4],
  C: [0.4, 0.6],
  B: [0.6, 0.8],
  A: [0.8, 1.0001],
}

export const SILVA = defineScorer('silva', SILVA_SCORE_BUCKETS)

/**
 * 第二个蒸馏评委（`Jannchie/silva-luna`），架构与输出域都和 SILVA 相同，所以复用
 * 同一套分档边界。它是**另一种口味**，不是更高一档 —— 两者并排存储，任选其一排序。
 */
export const SILVA_LUNA = defineScorer('silva_luna', SILVA_SCORE_BUCKETS)

/**
 * `post_aesthetic_scores` 里 `scorer` 列的取值注册表。
 *
 * ⚠️ waifu **不在**这里，而且不该进来：它有自己的表和自己的原生域。这张表回答的是
 * “通用分数表里住着谁”，`countByScorerBucket` 之类按 `scorer` 列分组的查询消费它。
 */
export const SCORERS: Record<string, ScorerSpec> = {
  [SILVA.name]: SILVA,
  [SILVA_LUNA.name]: SILVA_LUNA,
}

/**
 * waifu 的分档：0–10 原生域。'A' 实际是 [8, 10]，同样靠 10.001 表达闭上界。
 */
export const WAIFU_SCORE_BUCKETS: Buckets = {
  E: [0, 2],
  D: [2, 4],
  C: [4, 6],
  B: [6, 8],
  A: [8, 10.001],
}

/**
 * 遗留的单打分器表 `post_waifu_scores`，包成同一个 `ScorerSpec` 接口。
 *
 * 它进不了 `SCORERS`（上面那条注释说明了原因），但“怎么 join、分数在哪一列、
 * 判空看哪一列”这三件事对它和对 SILVA 是同一种知识。不包起来的代价是实测的：
 * `LEFT JOIN post_waifu_scores pws ON ...` 这个字面量此前在 `filters.ts`、
 * `queries/counts.ts`（两处）、`queries/post-search.ts` 抄了 4 遍，而“是不是已经
 * join 过了”的判断在 3 处用的是**裸子串** `includes('post_waifu_scores')` —— 和
 * `isJoined` 的整词匹配是两种方言，混用迟早出事。
 */
export const WAIFU = defineScorer('waifu', WAIFU_SCORE_BUCKETS, {
  table: 'post_waifu_scores',
  alias: 'pws',
  scoped: false,
  // 0–10 抬到 1–5：native * 0.4 + 1。
  scale: 0.4,
})

/**
 * 前端能按它**过滤**（`<name>_score_levels`）和**排序**（`<name>_score`）的分数，
 * 按 UI 顺序。加一个打分器 = 这里多一项。
 *
 * `filters.ts` 的分档过滤与 `hasActiveFilters`、`ORDERABLE_COLUMNS`、
 * `post-search.ts` 的虚拟排序、`apps/api` 的 zod schema 全部由它派生，`PostFilter`
 * 上的分档字段也是从它的名字映射出来的类型。
 *
 * 和 `SCORERS` 成员不同是**故意**的：那张表按“分数存在哪”分，这张按“前端能不能
 * 拿它筛”分，waifu 满足后者不满足前者。
 */
export const FILTERABLE_SCORERS = [WAIFU, SILVA, SILVA_LUNA] as const

export type FilterableScorerName = typeof FILTERABLE_SCORERS[number]['name']

/** `PostFilter` 上的分档字段名，例如 `silva_luna_score_levels`。 */
export function levelsField<N extends string>(spec: { readonly name: N }): `${N}_score_levels` {
  return `${spec.name}_score_levels`
}

/** 排序列名，例如 `silva_luna_score`。 */
export function orderColumn<N extends string>(spec: { readonly name: N }): `${N}_score` {
  return `${spec.name}_score`
}


export const SCORE_BUCKET_UNSCORED = 'UNSCORED'

/**
 * 生成给一行打分档标签的 CASE。
 *
 * 过滤（`buildWhere`）和聚合（分档计数）共用它，好让每个打分器的 A–E 边界只有
 * 一处定义。标签和边界只来自可信的 `buckets`，没有调用方输入进入这个字符串。
 */
export function bucketCaseSql(buckets: Buckets, scoreCol: string, nullCol: string): string {
  // 按下界从高到低；最低那档落到 ELSE。
  const ordered = Object.entries(buckets).sort((a, b) => b[1][0] - a[1][0])
  const above = ordered.slice(0, -1)
  const lowestLabel = ordered[ordered.length - 1]![0]
  const whens = above.map(([label, [lo]]) => `WHEN ${scoreCol} >= ${lo} THEN '${label}'`).join('\n')
  return `CASE\nWHEN ${nullCol} IS NULL THEN '${SCORE_BUCKET_UNSCORED}'\n${whens}\nELSE '${lowestLabel}'\nEND`
}
