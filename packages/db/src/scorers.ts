/**
 * 打分器注册表 —— 形状承自已退役的 Python 侧 `server/src/scorers.py`。
 *
 * 真正跨进程的只有**名字**（`SILVA_SCORERS`，定义在 `@pictoria/contracts`）；
 * `scorers.test.ts` 断言 `SCORERS` 的名字集合与它相等。join SQL 与分档边界只有这一侧在用。
 *
 * TS 后端里所有“按打分器枚举”的地方都从 `SCORERS` / `FILTERABLE_SCORERS` 遍历生成：
 * 文件夹聚合（`repositories/folders.ts`）、`/v2/folders` 的 `<key>Avg` 字段、
 * `/v2/posts/count/<slug>` 分档计数端点、`PostFilter` 的 `<key>ScoreLevels` 字段、
 * 调度器的 silva 循环。
 *
 * `post_aesthetic_scores` 是通用的 per-(post, scorer) 表；每个住在里面的打分器由
 * 一条 `ScorerSpec` 描述一次：DB 里的 `scorer` 名、join 用的别名、A–E 分档边界、
 * 以及把原生分抬到人工 1–5 星标度的仿射映射。加一个打分器 = 加一条注册项，而不是
 * 到处再抄一遍 LEFT JOIN / CASE。
 *
 * 已退役的打分器（2026-11）：waifu（`post_waifu_scores` 表）和 `silva_luna`。在盲打
 * 数据上两者对人工分的解释力都被 `silva` 完全覆盖（叠加无增益），所以筛选 / 排序 /
 * 后台打分全部移除。**库里的分数行原样保留**，只是不再有代码读写它们。
 */

export const AESTHETIC_SCORES_TABLE = 'post_aesthetic_scores'

/** 半开区间 [lo, hi)。 */
export type Buckets = Record<string, readonly [number, number]>

export interface ScorerSpec {
  /** `post_aesthetic_scores.scorer` 里的值，也是 SQL 别名和排序列的词根。 */
  readonly name: string
  /** JSON 字段名的词根（camelCase）：`silva` → `silvaScoreLevels`。 */
  readonly key: string
  readonly buckets: Buckets
  /** 抬到 1–5 标度：native * scale + offset。 */
  readonly scale: number
  readonly offset: number
  /** SQL 别名，例如 `pas_silva`。 */
  readonly alias: string
  /** 给人看的名字，进 OpenAPI 描述，例如 `SILVA`。 */
  readonly label: string
  /** `PostFilter.<key>ScoreLevels` 字段的 OpenAPI 描述。 */
  readonly levelsDescription: string
  joinSql: (opts?: { alias?: string, tableAlias?: string }) => string
  isJoined: (joins: Iterable<string>) => boolean
  scoreCol: (alias?: string) => string
  nullCol: (alias?: string) => string
  scoreExpr: (alias?: string) => string
}

interface DefineOptions {
  /** 见 `ScorerSpec.label`。 */
  readonly label: string
  /** 见 `ScorerSpec.levelsDescription`。 */
  readonly levelsDescription: string
  /** 分数所在的表。默认是通用的 `post_aesthetic_scores`。 */
  readonly table?: string
  readonly alias?: string
  readonly scale?: number
  readonly offset?: number
  /**
   * join 是否带 `scorer = '<name>'` 谓词。
   *
   * 只有通用表需要它 —— 一张表里住着多个打分器，不加就把别人的分也 join 进来了。
   * 独占一张表的打分器传 false。
   */
  readonly scoped?: boolean
}

/**
 * 返回类型带上字面量 `name` / `key`，`FILTERABLE_SCORERS` 才能派生出
 * 打分器 key 的联合类型，进而派生出 `PostFilter` 上的
 * `<key>ScoreLevels` 字段名。收窄成 `string` 的话下游就只能手写字段名了。
 */
function defineScorer<N extends string, K extends string>(
  name: N,
  key: K,
  buckets: Buckets,
  { label, levelsDescription, table = AESTHETIC_SCORES_TABLE, alias = `pas_${name}`, scale = 4, offset = 1, scoped = true }: DefineOptions,
): ScorerSpec & { readonly name: N, readonly key: K } {
  return {
    name,
    key,
    buckets,
    scale,
    offset,
    alias,
    label,
    levelsDescription,
    joinSql: ({ alias: a = alias, tableAlias = 'p' } = {}) =>
      `LEFT JOIN ${table} ${a} ON ${a}.post_id = ${tableAlias}.id${scoped ? ` AND ${a}.scorer = '${name}'` : ''}`,
    /**
     * 别名要按**整词**匹配（空格分隔）。裸子串判断在两个打分器名共享前缀时就会错：
     * `pas_silva` 是 `pas_silva_x` 的子串，于是对后者的过滤会被误判成前者已 join，
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

export const SILVA = defineScorer('silva', 'silva', SILVA_SCORE_BUCKETS, {
  label: 'SILVA',
  levelsDescription: "SILVA aesthetic bucket filter. Each value is one of 'A' (0.8-1.0), 'B' (0.6-0.8), 'C' (0.4-0.6), 'D' (0.2-0.4), 'E' (0-0.2), or 'UNSCORED' (no SILVA score yet). OR together.",
})

/**
 * `post_aesthetic_scores` 里 `scorer` 列的取值注册表，按 UI 顺序。**TS 侧唯一来源**：
 * 加一个 SILVA 类打分器 = 这里 `defineScorer` 一项并追加进来（外加 contracts 的
 * `SILVA_SCORERS` 和 worker），后端其余地方都由它遍历生成。
 *
 * 这张表回答的是“通用分数表里还在用的是谁” —— 表里另有已退役打分器留下的行，
 * 读分数的查询都按这里的名字收窄，所以那些行不会漏到 API 里。
 *
 * 是元组而不是 `Record<string, ScorerSpec>`：下游要从它派生字面量联合
 * （打分器名、`<key>Avg` 字段名）。
 */
export const SCORERS = [SILVA] as const

export type AestheticScorer = typeof SCORERS[number]
export type AestheticScorerName = AestheticScorer['name']
export type AestheticScorerKey = AestheticScorer['key']

/**
 * 前端能按它**过滤**（`<key>ScoreLevels`）和**排序**（`<name>_score`）的分数，
 * 按 UI 顺序。加一个打分器 = 这里多一项。
 *
 * `filters.ts` 的分档过滤与 `hasActiveFilters`、`ORDERABLE_COLUMNS`、
 * `post-search.ts` 的虚拟排序、`apps/api` 的 zod schema 全部由它派生，`PostFilter`
 * 上的分档字段也是从它的名字映射出来的类型。
 *
 * 和 `SCORERS` 是两张表是**故意**的：那张按“分数存在通用表里”分，这张按“前端能不能
 * 拿它筛”分。现在两者成员相同，但住在独立表里的打分器只会进这一张。
 */
export const FILTERABLE_SCORERS = [SILVA] as const

export type FilterableScorerKey = typeof FILTERABLE_SCORERS[number]['key']

/** `PostFilter` 上的分档字段名，例如 `silvaScoreLevels`。 */
export function levelsField<K extends string>(spec: { readonly key: K }): `${K}ScoreLevels` {
  return `${spec.key}ScoreLevels`
}

/** 排序列名，例如 `silva_score`。 */
export function orderColumn<N extends string>(spec: { readonly name: N }): `${N}_score` {
  return `${spec.name}_score`
}

/** PascalCase 词根，用于 OpenAPI 组件名 / operationId：`silva` → `Silva`。 */
export function pascalKey<K extends string>(spec: { readonly key: K }): Capitalize<K> {
  return (spec.key.charAt(0).toUpperCase() + spec.key.slice(1)) as Capitalize<K>
}

/** URL 段：下划线换成连字符。 */
export function urlSlug(spec: { readonly name: string }): string {
  return spec.name.replaceAll('_', '-')
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
