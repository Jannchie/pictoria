/**
 * TS 的 `buildWhere` 必须和 Python 的 `build_where` 产出**逐字符相同**的 SQL。
 *
 * 固件 `__fixtures__/where-golden.json` 是从运行中的 Python 侧直接 dump 的
 * （scratchpad/dump_where.py），不是手写的期望值 —— 手写期望值只能证明"我以为它
 * 该输出什么"。用例覆盖每个分支及其组合，包括那个别名前缀坑的现场
 * （`both_silva`：`pas_silva` 是 `pas_silva_luna` 的子串）。
 *
 * 固件已**冻结**：Python 参照实现随 Litestar 一起退役了，再也生成不出新的。这不影响
 * 这个测试的价值 —— 它比的是 SQL 文本，确定性的，不会因为库里的数据变化而陈旧。
 *
 * 一并退役的是 `query-parity.test.ts`（把同一批 filter 真打到生产库上比计数和前 20 个
 * id）。它证明的是文本比对看不出的东西：参数绑定顺序、LEFT JOIN 之后 WHERE 的语义。
 * 删它不是因为没价值，而是因为它钉在**活库**上 —— 在应用里改一次评分它就红，而唯一的
 * 修法是从 Python 侧重新 dump，那条路已经没了。留着只会训练出"这个测试老是红的"。
 * 它退役前最后一次全绿的记录在 `docs/refactor-monorepo-hono.md` 的 Phase 7。
 */
import { describe, expect, it } from 'vitest'
import golden from './__fixtures__/where-golden.json' with { type: 'json' }
import { buildWhere, hasActiveFilters, type PostFilter } from './filters.js'
import { SILVA, SILVA_LUNA } from './scorers.js'

interface GoldenCase {
  name: string
  filter: Record<string, unknown>
  where: string[]
  params: unknown[]
  joins: string[]
  has_active_filters: boolean
}

const cases = golden as unknown as GoldenCase[]

describe('buildWhere 与 Python 侧逐字符一致', () => {
  it('固件确实覆盖了所有分支', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    // 别名前缀坑的现场必须在
    expect(cases.map(c => c.name)).toContain('both_silva')
  })

  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const actual = buildWhere(c.filter as PostFilter)
    expect(actual.where).toEqual(c.where)
    expect(actual.params).toEqual(c.params)
    expect(actual.joins).toEqual(c.joins)
  })
})

describe('hasActiveFilters 与 Python 侧一致', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(hasActiveFilters(c.filter as PostFilter)).toBe(c.has_active_filters)
  })
})

describe('别名整词匹配（前缀相同的打分器不能互相误判）', () => {
  it('pas_silva 的 join 不算作 pas_silva_luna 已 join', () => {
    const joins = [SILVA.joinSql()]
    expect(SILVA.isJoined(joins)).toBe(true)
    expect(SILVA_LUNA.isJoined(joins)).toBe(false)
  })

  it('反过来也成立', () => {
    const joins = [SILVA_LUNA.joinSql()]
    expect(SILVA_LUNA.isJoined(joins)).toBe(true)
    expect(SILVA.isJoined(joins)).toBe(false)
  })
})
