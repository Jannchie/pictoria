/**
 * 打分器注册表 —— 对应 Python 侧 `db/scorers.py`。
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

function defineScorer(name: string, buckets: Buckets, scale = 4, offset = 1): ScorerSpec {
  const alias = `pas_${name}`
  return {
    name,
    buckets,
    scale,
    offset,
    alias,
    joinSql: ({ alias: a = alias, tableAlias = 'p' } = {}) =>
      `LEFT JOIN ${AESTHETIC_SCORES_TABLE} ${a} ON ${a}.post_id = ${tableAlias}.id AND ${a}.scorer = '${name}'`,
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
