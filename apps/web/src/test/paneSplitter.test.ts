import { describe, expect, it } from 'vitest'
import { splitterKeyAction } from '@/utils/paneSplitter'

const range = { value: 12, min: 8, max: 36 }

describe('splitterkeyaction', () => {
  it('grows the primary pane toward its grow key, 1 % (shift 10 %)', () => {
    expect(splitterKeyAction({ key: 'ArrowRight' }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 13 })
    expect(splitterKeyAction({ key: 'ArrowLeft' }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 11 })
    expect(splitterKeyAction({ key: 'ArrowRight', shiftKey: true }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 22 })
  })

  it('mirrors for a right-hand pane', () => {
    expect(splitterKeyAction({ key: 'ArrowLeft' }, range, 'ArrowLeft')).toEqual({ type: 'resize', value: 13 })
    expect(splitterKeyAction({ key: 'ArrowRight' }, range, 'ArrowLeft')).toEqual({ type: 'resize', value: 11 })
  })

  it('clamps to min/max and reports no-ops at a bound as null', () => {
    expect(splitterKeyAction({ key: 'ArrowLeft', shiftKey: true }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 8 })
    expect(splitterKeyAction({ key: 'ArrowLeft' }, { ...range, value: 8 }, 'ArrowRight')).toBeNull()
    expect(splitterKeyAction({ key: 'ArrowRight' }, { ...range, value: 36 }, 'ArrowRight')).toBeNull()
  })

  it('home / end jump to min / max, enter collapses', () => {
    expect(splitterKeyAction({ key: 'Home' }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 8 })
    expect(splitterKeyAction({ key: 'End' }, range, 'ArrowRight')).toEqual({ type: 'resize', value: 36 })
    expect(splitterKeyAction({ key: 'Enter' }, range, 'ArrowRight')).toEqual({ type: 'collapse' })
  })

  it('rounds drag-produced fractions and ignores modified keys', () => {
    expect(splitterKeyAction({ key: 'ArrowRight' }, { ...range, value: 12.3456 }, 'ArrowRight')).toEqual({ type: 'resize', value: 13.3 })
    expect(splitterKeyAction({ key: 'ArrowRight', ctrlKey: true }, range, 'ArrowRight')).toBeNull()
    expect(splitterKeyAction({ key: 'a' }, range, 'ArrowRight')).toBeNull()
  })
})
