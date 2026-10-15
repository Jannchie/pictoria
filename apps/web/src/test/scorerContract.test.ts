import type { DirectorySummary, PostFilter, TagCountRequest } from '@/api'
import type { PostFilterFacets, PostOrderColumn } from '@/shared/postFilter'
import type { SCORERS, ScorerUi } from '@/shared/scorers'
import { describe, expectTypeOf, it } from 'vitest'

/**
 * `src/shared/scorers.ts` is a hand-synced twin of the backend's
 * `packages/db/src/scorers.ts` (`apps/web` can't depend on `@pictoria/db`).
 * The generated API types are the one thing both sides share, so the guard is
 * type-level: every assertion below is checked by `vue-tsc` (part of
 * `pnpm build`), and a scorer added on one side only makes the build fail.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

/** The scorers actually in the table (not just the union the interface allows). */
type TableScorer = (typeof SCORERS)[number]

/** `<key>ScoreLevels` fields the backend's PostFilter accepts. */
type ApiLevelsField = Extract<keyof PostFilter, `${string}ScoreLevels`>
/** camelCase scorer keys, from the levels field names. */
type KeyOf<F> = F extends `${infer K}ScoreLevels` ? K : never
/** `<key>Avg` fields of the folder summary that belong to a scorer. */
type ApiAvgKey = Extract<keyof DirectorySummary, `${string}Avg`> extends infer F
  ? F extends `${infer K}Avg` ? Exclude<K, 'score' | 'rating'> : never
  : never

// 表里的分档字段 ≡ 后端 PostFilter 的 <key>ScoreLevels 字段（双向，少一个多一个都不行）。
export type _LevelsMatchApi = Expect<Equal<TableScorer['levelsField'], ApiLevelsField>>
// 接口声明的联合也不能比表宽（否则 Record<ScorerUi['name'], …> 会要求不存在的项）。
export type _InterfaceMatchesTable = Expect<Equal<ScorerUi['name'], TableScorer['name']>>
export type _InterfaceLevelsMatchTable = Expect<Equal<ScorerUi['levelsField'], TableScorer['levelsField']>>
// 每个后端文件夹聚合的 <key>Avg 都对应表里的一个打分器（waifu 不进文件夹聚合，所以是子集）。
export type _AvgKeysAreScorers = Expect<ApiAvgKey extends KeyOf<TableScorer['levelsField']> ? true : false>
// countKind 就是 camelCase key。
export type _CountKindIsKey = Expect<Equal<TableScorer['countKind'], KeyOf<TableScorer['levelsField']>>>

describe('scorer twin ↔ generated api contract', () => {
  it('levels fields match postfilter / tagcountrequest', () => {
    expectTypeOf<TableScorer['levelsField']>().toEqualTypeOf<ApiLevelsField>()
    expectTypeOf<Extract<keyof TagCountRequest, `${string}ScoreLevels`>>().toEqualTypeOf<ApiLevelsField>()
  })

  it('every scorer has an orderby column', () => {
    expectTypeOf<`${TableScorer['name']}_score`>().toExtend<PostOrderColumn>()
  })

  it('the client filter state carries every levels field', () => {
    expectTypeOf<Extract<keyof PostFilterFacets, `${string}ScoreLevels`>>().toEqualTypeOf<ApiLevelsField>()
  })

  it('the folder summary averages belong to known scorers', () => {
    expectTypeOf<ApiAvgKey>().toExtend<KeyOf<TableScorer['levelsField']>>()
  })
})
