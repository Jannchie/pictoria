/**
 * `SCORERS` 是 TS 侧打分器的唯一来源；真正跨进程的名字表在 `@pictoria/contracts`
 * 的 `SILVA_SCORERS`（worker 认的就是它）。两边漂了的症状是某个打分器的循环在跑、
 * 却没有对应的过滤字段 / 计数端点（或者反过来），所以在这里钉死两边相等。
 */
import type { SilvaScorer } from '@pictoria/contracts'
import { SILVA_SCORERS } from '@pictoria/contracts'
import { describe, expect, it } from 'vitest'
import { FILTERABLE_SCORERS, pascalKey, SCORERS, urlSlug } from './scorers.js'

describe('SCORERS', () => {
  it('名字集合 == contracts 的 SILVA_SCORERS', () => {
    // 类型层面也挡一道：SCORERS 里出现 contracts 不认识的名字就编译不过。
    const names: readonly SilvaScorer[] = SCORERS.map(s => s.name)
    expect([...names].sort()).toEqual([...SILVA_SCORERS].sort())
  })

  it('name / key / alias 互不重复', () => {
    for (const field of ['name', 'key', 'alias'] as const) {
      const values = FILTERABLE_SCORERS.map(s => s[field])
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('每个打分器都在 FILTERABLE_SCORERS 里', () => {
    for (const s of SCORERS) expect(FILTERABLE_SCORERS).toContain(s)
  })

  it('派生名', () => {
    expect(SCORERS.map(pascalKey)).toEqual(['Silva'])
    expect(SCORERS.map(urlSlug)).toEqual(['silva'])
    // 现在没有带下划线 / 多词的打分器了，变换本身用假想的名字钉住。
    expect(pascalKey({ key: 'silvaX' })).toBe('SilvaX')
    expect(urlSlug({ name: 'silva_x' })).toBe('silva-x')
  })
})
