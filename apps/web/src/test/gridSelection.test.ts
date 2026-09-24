import { describe, expect, it } from 'vitest'
import { extendRange, nextCursorAfterRemoval, rangeBetween } from '@/utils/gridSelection'

const ORDER = [10, 20, 30, 40, 50, 60]

function sorted(set: Set<number | undefined>): number[] {
  return [...set].filter((id): id is number => typeof id === 'number').sort((a, b) => a - b)
}

describe('rangebetween', () => {
  it('returns the inclusive slice in list order, whichever end comes first', () => {
    expect(rangeBetween(ORDER, 20, 40)).toEqual([20, 30, 40])
    expect(rangeBetween(ORDER, 40, 20)).toEqual([20, 30, 40])
  })

  it('is a single id when both ends are the same', () => {
    expect(rangeBetween(ORDER, 30, 30)).toEqual([30])
  })

  it('is empty when either end is not in the list', () => {
    expect(rangeBetween(ORDER, 99, 30)).toEqual([])
    expect(rangeBetween(ORDER, 30, 99)).toEqual([])
  })
})

describe('extendrange', () => {
  it('grows from a single anchor into a range', () => {
    expect(sorted(extendRange([30], ORDER, 30, 30, 50))).toEqual([30, 40, 50])
  })

  it('shrinks back towards the anchor, dropping what the previous range added', () => {
    const grown = extendRange([30], ORDER, 30, 30, 60)
    expect(sorted(extendRange(grown, ORDER, 30, 60, 40))).toEqual([30, 40])
  })

  it('flips across the anchor', () => {
    const down = extendRange([30], ORDER, 30, 30, 50)
    expect(sorted(extendRange(down, ORDER, 30, 50, 10))).toEqual([10, 20, 30])
  })

  it('keeps items selected outside the range (ctrl / space toggles)', () => {
    expect(sorted(extendRange([10, 40], ORDER, 40, 40, 60))).toEqual([10, 40, 50, 60])
  })

  it('does not mutate the input set', () => {
    const input = new Set([30])
    extendRange(input, ORDER, 30, 30, 50)
    expect([...input]).toEqual([30])
  })
})

describe('nextcursorafterremoval', () => {
  it('keeps a cursor that survives', () => {
    expect(nextCursorAfterRemoval(ORDER, [20], 40)).toBe(40)
  })

  it('moves to the next surviving item after the cursor', () => {
    expect(nextCursorAfterRemoval(ORDER, [30, 40], 30)).toBe(50)
  })

  it('falls back to the previous surviving item at the end of the list', () => {
    expect(nextCursorAfterRemoval(ORDER, [50, 60], 60)).toBe(40)
  })

  it('uses the first removed item as the pivot when there is no cursor', () => {
    expect(nextCursorAfterRemoval(ORDER, [40, 20], null)).toBe(30)
  })

  it('uses the first removed item as the pivot when the cursor left the list', () => {
    expect(nextCursorAfterRemoval(ORDER, [60], 99)).toBe(50)
  })

  it('returns null when nothing survives', () => {
    expect(nextCursorAfterRemoval([1, 2], [1, 2], 1)).toBeNull()
    expect(nextCursorAfterRemoval([], [], null)).toBeNull()
  })

  it('picks the first item when nothing removed is in the list and there is no cursor', () => {
    expect(nextCursorAfterRemoval(ORDER, [99], null)).toBe(10)
  })
})
