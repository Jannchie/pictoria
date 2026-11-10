/**
 * 前端这一侧的打分器表。
 *
 * ⚠️ 这是 `packages/db/src/scorers.ts` 的 `FILTERABLE_SCORERS` 的**手工同步孪生**。
 * 不能直接复用后端那份：`apps/web` 不依赖任何 `@pictoria/*` 包，而
 * `@pictoria/db` 里有 better-sqlite3，进不了浏览器打包。
 *
 * 真正跨进程的只有**名字**（`name`），过滤字段名和排序列名都是从它派生的，所以
 * 两边漂开的唯一方式是名字拼错 —— 那会立刻表现为过滤没有任何效果。
 *
 * 加一个打分器：这里加一项，在 `ScoreBucketFilter.vue` 的计数端点表和
 * `mutations.ts` 的单帖重算端点表（`SCORE_ONE`）里各加一行（生成的 SDK 函数没法
 * 从表里拿；两张表都是 `Record<…>`，漏了编译不过），
 * 以及 i18n 的 label。其余的筛选按钮、chip、DSL、默认过滤值、URL 同步、命令面板
 * 写回全部由这张表派生（见 `./postFilter`）。
 *
 * 与后端的同步由 `src/test/scorerContract.test.ts` 在类型层面守护：`levelsField`
 * 必须与生成的 `PostFilter` 上 `<key>ScoreLevels` 字段一一对应，排序列必须在生成的
 * `orderBy` 联合里 —— 后端加了打分器而这里没加（或反过来），`vue-tsc` 直接失败。
 */
export interface ScorerUi {
  /** 后端的打分器名，也是字段名的词根。 */
  readonly name: 'waifu' | 'silva' | 'silva_luna'
  /** `postFilter` 上的分档字段。 */
  readonly levelsField: 'waifuScoreLevels' | 'silvaScoreLevels' | 'silvaLunaScoreLevels'
  /**
   * 计数 query 的 kind（`CountKind` 的一员 —— `COUNT_KINDS` 从这里派生，所以这里
   * 不能反过来引用 `CountKind`），也是单帖重算（`computeScore`）的 key。
   */
  readonly countKind: 'waifu' | 'silva' | 'silvaLuna'
  /**
   * 这个打分器的分数是否进侧栏文件夹树的每文件夹聚合（`/v2/folders`）。重算一张
   * 图之后据此决定要不要把文件夹树标脏。
   */
  readonly feedsFolderAggregates: boolean
  /** 过滤 DSL 里的键 —— 是短名，`silva_luna` 在 DSL 里写作 `luna`。 */
  readonly dslKey: string
  /** chip 上的前缀。产品名，不进 i18n。 */
  readonly chipPrefix: string
  /** 这个打分器在所有地方（筛选按钮、chip、排序项、面板、底栏）共用的唯一图标。 */
  readonly icon: string
  /** 筛选按钮 / 列表的名字（i18n key）。 */
  readonly filterLabelKey: string
  /** 分档弹层每一档的数值区间文案（按 level）。 */
  readonly bucketRanges: Readonly<Record<string, string>>
}

const UNIT_RANGES = { A: '0.8 – 1.0', B: '0.6 – 0.8', C: '0.4 – 0.6', D: '0.2 – 0.4', E: '0 – 0.2' } as const

/** UI 顺序，与后端 `FILTERABLE_SCORERS` 一致。 */
// `as const satisfies`：保留每一项的字面量类型，类型守护（scorerContract.test.ts）
// 才能从 `typeof SCORERS` 读出"表里实际有哪些打分器"，而不是接口声明的全集。
export const SCORERS = [
  {
    name: 'waifu',
    levelsField: 'waifuScoreLevels',
    countKind: 'waifu',
    feedsFolderAggregates: false,
    dslKey: 'waifu',
    chipPrefix: 'Waifu',
    icon: 'i-tabler-heart',
    filterLabelKey: 'filter.waifuScore',
    bucketRanges: { A: '8 – 10', B: '6 – 8', C: '4 – 6', D: '2 – 4', E: '0 – 2' },
  },
  {
    name: 'silva',
    levelsField: 'silvaScoreLevels',
    countKind: 'silva',
    feedsFolderAggregates: true,
    dslKey: 'silva',
    chipPrefix: 'SILVA',
    icon: 'i-tabler-rosette',
    filterLabelKey: 'filter.silvaScore',
    bucketRanges: UNIT_RANGES,
  },
  {
    name: 'silva_luna',
    levelsField: 'silvaLunaScoreLevels',
    countKind: 'silvaLuna',
    feedsFolderAggregates: true,
    dslKey: 'luna',
    chipPrefix: 'Luna',
    icon: 'i-tabler-moon',
    filterLabelKey: 'filter.silvaLunaScore',
    bucketRanges: UNIT_RANGES,
  },
] as const satisfies readonly ScorerUi[]

/** 排序列名，例如 `silva_luna_score`。 */
export function scorerOrderColumn(spec: ScorerUi): string {
  return `${spec.name}_score`
}

/** A scorer's `countKind` — also the key the detail panel's on-demand scorers use. */
export type ScorerKind = typeof SCORERS[number]['countKind']

/** A scorer's one icon (filter button, chip, sort option, panels, footer). */
export function scorerIcon(name: ScorerUi['name']): string {
  return SCORERS.find(s => s.name === name)!.icon
}
