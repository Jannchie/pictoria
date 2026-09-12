/**
 * `buildWhere` 的 SQL 文本钉在一份冻结的固件上。
 *
 * 固件 `__fixtures__/where-golden.json` 是从已退役的 Python 参照实现直接 dump 的，
 * 不是手写的期望值 —— 手写期望值只能证明"我以为它该输出什么"。用例覆盖每个分支
 * 及其组合，包括那个别名前缀坑的现场（`both_silva`：`pas_silva` 是 `pas_silva_luna`
 * 的子串）。它比的是 SQL 文本，确定性的，不会因为库里的数据变化而陈旧；也再生成
 * 不出新的，所以固件里的过滤器键仍是当年的 snake_case，进 `buildWhere` 前换成
 * 现在的 camelCase。
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

/** 固件里的 snake_case 键 → 现在的 `PostFilter` 字段名。 */
function toPostFilter(filter: Record<string, unknown>): PostFilter {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(filter))
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  return out as PostFilter
}

describe('buildWhere 与冻结固件逐字符一致', () => {
  it('固件确实覆盖了所有分支', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    // 别名前缀坑的现场必须在
    expect(cases.map(c => c.name)).toContain('both_silva')
  })

  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const actual = buildWhere(toPostFilter(c.filter))
    expect(actual.where).toEqual(c.where)
    expect(actual.params).toEqual(c.params)
    expect(actual.joins).toEqual(c.joins)
  })
})

describe('hasActiveFilters 与冻结固件一致', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(hasActiveFilters(toPostFilter(c.filter))).toBe(c.has_active_filters)
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
