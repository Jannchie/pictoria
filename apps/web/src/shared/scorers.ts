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
 * 加一个打分器：这里加一项，加一个 `<Name>ScoreFilter.vue`（因为它的计数端点是
 * 生成的 SDK 函数，没法从表里拿），以及 i18n 的两条 label。其余的 chip、DSL、
 * 默认过滤值、URL 同步全部由这张表派生。
 */
import type { CountKind } from './queryKeys'

export interface ScorerUi {
  /** 后端的打分器名，也是字段名的词根。 */
  readonly name: 'waifu' | 'silva' | 'silva_luna'
  /** `postFilter` 上的分档字段。 */
  readonly levelsField: 'waifu_score_levels' | 'silva_score_levels' | 'silva_luna_score_levels'
  /** 计数 query 的 kind。 */
  readonly countKind: CountKind
  /** 过滤 DSL 里的键 —— 是短名，`silva_luna` 在 DSL 里写作 `luna`。 */
  readonly dslKey: string
  /** chip 上的前缀。产品名，不进 i18n。 */
  readonly chipPrefix: string
  readonly icon: string
}

/** UI 顺序，与后端 `FILTERABLE_SCORERS` 一致。 */
export const SCORERS: readonly ScorerUi[] = [
  { name: 'waifu', levelsField: 'waifu_score_levels', countKind: 'waifu', dslKey: 'waifu', chipPrefix: 'Waifu', icon: 'i-tabler-heart' },
  { name: 'silva', levelsField: 'silva_score_levels', countKind: 'silva', dslKey: 'silva', chipPrefix: 'SILVA', icon: 'i-tabler-rosette' },
  { name: 'silva_luna', levelsField: 'silva_luna_score_levels', countKind: 'silvaLuna', dslKey: 'luna', chipPrefix: 'Luna', icon: 'i-tabler-moon' },
]

/** 排序列名，例如 `silva_luna_score`。 */
export function scorerOrderColumn(spec: ScorerUi): string {
  return `${spec.name}_score`
}
