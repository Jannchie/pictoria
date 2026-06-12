import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import {
  firstRovingIndex,
  lastRovingIndex,
  nextRovingIndex,
  useRovingIndex,
} from '@/composables/useRovingIndex'

describe('nextrovingindex', () => {
  it('treats -1 as unanchored: down lands on first, up on last', () => {
    expect(nextRovingIndex(-1, 1, 5)).toBe(0)
    expect(nextRovingIndex(-1, -1, 5)).toBe(4)
  })

  it('wraps around the ends', () => {
    expect(nextRovingIndex(4, 1, 5)).toBe(0) // last -> first
    expect(nextRovingIndex(0, -1, 5)).toBe(4) // first -> last
  })

  it('moves within bounds', () => {
    expect(nextRovingIndex(1, 1, 5)).toBe(2)
    expect(nextRovingIndex(2, -1, 5)).toBe(1)
  })

  it('handles a single-item list', () => {
    expect(nextRovingIndex(0, 1, 1)).toBe(0)
    expect(nextRovingIndex(0, -1, 1)).toBe(0)
    expect(nextRovingIndex(-1, 1, 1)).toBe(0)
    expect(nextRovingIndex(-1, -1, 1)).toBe(0)
  })
})

describe('first/lastrovingindex', () => {
  it('returns the bounds for a non-empty list', () => {
    expect(firstRovingIndex(3)).toBe(0)
    expect(lastRovingIndex(3)).toBe(2)
  })

  it('returns -1 for the first index of an empty list', () => {
    expect(firstRovingIndex(0)).toBe(-1)
  })
})

describe('userovingindex', () => {
  it('moves the internal index with wrap-around and fires onmove', () => {
    const onMove = vi.fn()
    const { index, move } = useRovingIndex({ count: () => 3, onMove })

    move(1)
    expect(index.value).toBe(0)
    move(1)
    move(1)
    expect(index.value).toBe(2)
    move(1)
    expect(index.value).toBe(0) // wrap
    move(-1)
    expect(index.value).toBe(2) // wrap back
    expect(onMove).toHaveBeenCalledTimes(5)
    expect(onMove).toHaveBeenLastCalledWith(2)
  })

  it('supports a controlled external index ref', () => {
    const external = ref(-1)
    const { index, move } = useRovingIndex({ count: () => 4, index: external })
    expect(index).toBe(external)
    move(-1)
    expect(external.value).toBe(3) // unanchored up -> last
  })

  it('first/last jump to the bounds', () => {
    const { index, first, last } = useRovingIndex({ count: () => 5 })
    last()
    expect(index.value).toBe(4)
    first()
    expect(index.value).toBe(0)
  })

  it('is a no-op on an empty list and never calls onmove', () => {
    const onMove = vi.fn()
    const { index, move, first, last } = useRovingIndex({ count: () => 0, onMove })
    move(1)
    first()
    last()
    expect(index.value).toBe(-1)
    expect(onMove).not.toHaveBeenCalled()
  })
})
