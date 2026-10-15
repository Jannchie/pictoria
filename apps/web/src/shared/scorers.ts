/**
 * 前端这一侧的打分器表。
 *
 * ⚠️ 这是 `packages/db/src/scorers.ts` 的 `FILTERABLE_SCORERS` 的**手工同步孪生**，
 * 和仓库里已有的 `server/src/scorers.py` ↔ `packages/db/src/scorers.ts` 是同一种
 * 安排。不能直接复用后端那份：`apps/web` 不依赖任何 `@pictoria/*` 包，而
 * `@pictoria/db` 里有 better-sqlite3，进不了浏览器打包。
 *
 * 真正跨进程的只有**名字**（`name`），过滤字段名和排序列名都是从它派生的，所以
 * 两边漂开的唯一方式是名字拼错 —— 那会立刻表现为过滤没有任何效果。
 *
 * 加一个打分器：这里加一项，在 `ScorerBucketFilter.vue` 的计数端点表里加一行
 * （生成的 SDK 函数没法从表里拿；那张表是 `Record<name, …>`，漏了编译不过），
 * 以及 i18n 的 label。其余的筛选按钮、chip、DSL、默认过滤值、URL 同步、命令面板
 * 写回全部由这张表派生（见 `./postFilter`）。
 *
 * 与后端的同步由 `src/test/scorerContract.test.ts` 在类型层面守护：`levelsField`
 * 必须与生成的 `PostFilter` 上 `<key>ScoreLevels` 字段一一对应，排序列必须在生成的
 * `orderBy` 联合里 —— 后端加了打分器而这里没加（或反过来），`vue-tsc` 直接失败。
 */
import type { CountKind } from './queryKeys'

export interface ScorerUi {
  /** 后端的打分器名，也是字段名的词根。 */
  readonly name: 'waifu' | 'silva' | 'silva_luna'
  /** `postFilter` 上的分档字段。 */
  readonly levelsField: 'waifuScoreLevels' | 'silvaScoreLevels' | 'silvaLunaScoreLevels'
  /** 计数 query 的 kind。 */
  readonly countKind: CountKind
  /** 过滤 DSL 里的键 —— 是短名，`silva_luna` 在 DSL 里写作 `luna`。 */
  readonly dslKey: string
  /** chip 上的前缀。产品名，不进 i18n。 */
  readonly chipPrefix: string
  /** chip 图标。 */
  readonly icon: string
  /** 筛选按钮图标（与 chip 图标历史上不同：waifu 的按钮是皇冠）。 */
  readonly filterIcon: string
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
    dslKey: 'waifu',
    chipPrefix: 'Waifu',
    icon: 'i-tabler-heart',
    filterIcon: 'i-tabler-crown',
    filterLabelKey: 'filter.waifuScore',
    bucketRanges: { A: '8 – 10', B: '6 – 8', C: '4 – 6', D: '2 – 4', E: '0 – 2' },
  },
  {
    name: 'silva',
    levelsField: 'silvaScoreLevels',
    countKind: 'silva',
    dslKey: 'silva',
    chipPrefix: 'SILVA',
    icon: 'i-tabler-rosette',
    filterIcon: 'i-tabler-rosette',
    filterLabelKey: 'filter.silvaScore',
    bucketRanges: UNIT_RANGES,
  },
  {
    name: 'silva_luna',
    levelsField: 'silvaLunaScoreLevels',
    countKind: 'silvaLuna',
    dslKey: 'luna',
    chipPrefix: 'Luna',
    icon: 'i-tabler-moon',
    filterIcon: 'i-tabler-moon',
    filterLabelKey: 'filter.silvaLunaScore',
    bucketRanges: UNIT_RANGES,
  },
] as const satisfies readonly ScorerUi[]

/** 排序列名，例如 `silva_luna_score`。 */
export function scorerOrderColumn(spec: ScorerUi): string {
  return `${spec.name}_score`
}
