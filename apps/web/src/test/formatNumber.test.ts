import { afterEach, describe, expect, it } from 'vitest'
import { formatNumber, localeSetting } from '@/locale'

describe('formatnumber', () => {
  const before = localeSetting.value
  afterEach(() => {
    localeSetting.value = before
  })

  it('groups by default', () => {
    localeSetting.value = 'en'
    expect(formatNumber(12_345)).toBe('12,345')
  })

  it('fractiondigits renders exactly what tofixed did in en', () => {
    localeSetting.value = 'en'
    for (const [n, d] of [[0, 1], [7.25, 1], [0.15, 1], [0.015, 2], [0.5, 2], [99.95, 1], [57.5, 0], [-0.04, 1]] as const) {
      expect(formatNumber(n, { fractionDigits: d, grouping: false })).toBe(n.toFixed(d))
    }
    // Below 1000 grouping never shows, so it can stay on.
    expect(formatNumber(7.06, { fractionDigits: 1 })).toBe('7.1')
  })

  it('grouping: false drops thousands separators', () => {
    localeSetting.value = 'en'
    expect(formatNumber(1200, { fractionDigits: 0 })).toBe('1,200')
    expect(formatNumber(1200, { fractionDigits: 0, grouping: false })).toBe('1200')
  })
})
