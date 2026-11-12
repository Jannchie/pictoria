/**
 * `buildWhere` 的 SQL 文本钉在一份冻结的固件上。
 *
 * 固件 `__fixtures__/where-golden.json` 是从已退役的 Python 参照实现直接 dump 的，
 * 不是手写的期望值 —— 手写期望值只能证明"我以为它该输出什么"。用例覆盖每个分支
 * 及其组合。它比的是 SQL 文本，确定性的，不会因为库里的数据变化而陈旧。冻结的是
 * 期望的 SQL；输入侧的过滤器键只是普通 JSON，随 `PostFilter` 改成了 camelCase。
 *
 * waifu / `silva_luna` 退役（2026-11）时删掉了它们的用例。原来只有 waifu 用例走到的
 * 两条通用分档分支（档位 + UNSCORED 混用、不认识的档位）改由 `silva_levels_and_unscored`
 * / `silva_bogus_level` 覆盖 —— 这两条是照 waifu 原用例的形状换成 silva 的别名和边界
 * 写的，不是 Python dump 出来的。别名前缀坑原来的现场 `both_silva`（`pas_silva` 是
 * `pas_silva_luna` 的子串）随第二个打分器一起没了，整词匹配改由文件末尾的用例钉住。
 */
import { describe, expect, it } from 'vitest'
import golden from './__fixtures__/where-golden.json' with { type: 'json' }
import { buildWhere, hasActiveFilters, type PostFilter } from './filters.js'
import { SILVA } from './scorers.js'

interface GoldenCase {
  name: string
  filter: Record<string, unknown>
  where: string[]
  params: unknown[]
  joins: string[]
  has_active_filters: boolean
}

const cases = golden as unknown as GoldenCase[]

describe('buildWhere 与冻结固件逐字符一致', () => {
  it('固件确实覆盖了所有分支', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
    // 通用分档分支（混用 UNSCORED、不认识的档位）必须有用例走到
    const names = cases.map(c => c.name)
    expect(names).toContain('silva_levels_and_unscored')
    expect(names).toContain('silva_bogus_level')
    // 已退役打分器的过滤键不该再出现在固件里
    const keys = cases.flatMap(c => Object.keys(c.filter))
    expect(keys.filter(k => /waifu|luna/i.test(k))).toEqual([])
  })

  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const actual = buildWhere(c.filter as PostFilter)
    expect(actual.where).toEqual(c.where)
    expect(actual.params).toEqual(c.params)
    expect(actual.joins).toEqual(c.joins)
  })
})

describe('hasActiveFilters 与冻结固件一致', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(hasActiveFilters(c.filter as PostFilter)).toBe(c.has_active_filters)
  })
})

describe('别名整词匹配（前缀相同的打分器不能互相误判）', () => {
  // 现在只剩一个打分器，前缀坑没有真实的第二方了；用一个假想的别名 `pas_silva_x`
  // （`pas_silva` 是它的子串）把整词匹配钉住，免得下次加打分器时再踩一遍。
  const prefixed = SILVA.joinSql({ alias: 'pas_silva_x' })

  it('pas_silva 自己的 join 算已 join', () => {
    expect(SILVA.isJoined([SILVA.joinSql()])).toBe(true)
  })

  it('pas_silva_x 的 join 不算作 pas_silva 已 join', () => {
    expect(prefixed).toContain('pas_silva_x')
    expect(SILVA.isJoined([prefixed])).toBe(false)
  })

  it('两个 join 都在时仍然认得出自己', () => {
    expect(SILVA.isJoined([prefixed, SILVA.joinSql()])).toBe(true)
  })
})
