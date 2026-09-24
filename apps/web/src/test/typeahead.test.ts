import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTypeaheadKey, matchTypeahead, useTypeahead } from '@/composables/useTypeahead'

const LABELS = ['Apple', 'banana', 'Avocado', 'blueberry', 'Cherry', 'apricot']

describe('matchtypeahead', () => {
  it('searches after the start index for a single char and wraps', () => {
    expect(matchTypeahead(LABELS, 'a', 0)).toBe(2) // after Apple → Avocado
    expect(matchTypeahead(LABELS, 'a', 2)).toBe(5)
    expect(matchTypeahead(LABELS, 'a', 5)).toBe(0) // wraps
    expect(matchTypeahead(LABELS, 'b', 4)).toBe(1)
  })

  it('cycles on a repeated char', () => {
    expect(matchTypeahead(LABELS, 'aa', 0)).toBe(2)
    expect(matchTypeahead(LABELS, 'aaa', 2)).toBe(5)
  })

  it('keeps the current item for a longer query that still matches', () => {
    expect(matchTypeahead(LABELS, 'ap', 0)).toBe(0)
    expect(matchTypeahead(LABELS, 'apr', 0)).toBe(5)
    expect(matchTypeahead(LABELS, 'bl', 1)).toBe(3)
  })

  it('is case-insensitive and nfkc-normalised', () => {
    expect(matchTypeahead(LABELS, 'C', -1)).toBe(4)
    expect(matchTypeahead(['ｆｕｌｌ', 'half'], 'fu', -1)).toBe(0) // full-width
    expect(matchTypeahead(['  padded'], 'p', -1)).toBe(0)
  })

  it('returns the only match even when it is the current item', () => {
    expect(matchTypeahead(LABELS, 'c', 4)).toBe(4)
  })

  it('returns -1 for no match / empty input', () => {
    expect(matchTypeahead(LABELS, 'z', 0)).toBe(-1)
    expect(matchTypeahead(LABELS, '', 0)).toBe(-1)
    expect(matchTypeahead([], 'a', 0)).toBe(-1)
  })

  it('treats -1 / out-of-range start as "from the top"', () => {
    expect(matchTypeahead(LABELS, 'a', -1)).toBe(0)
    expect(matchTypeahead(LABELS, 'a', 99)).toBe(0)
  })
})

function ev(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...init } as KeyboardEvent
}

describe('istypeaheadkey', () => {
  it('accepts printable single chars without ctrl/meta/alt', () => {
    expect(isTypeaheadKey(ev('a'))).toBe(true)
    expect(isTypeaheadKey(ev('A', { shiftKey: true } as Partial<KeyboardEvent>))).toBe(true)
    expect(isTypeaheadKey(ev('中'))).toBe(true)
    expect(isTypeaheadKey(ev('a', { ctrlKey: true }))).toBe(false)
    expect(isTypeaheadKey(ev('a', { metaKey: true }))).toBe(false)
    expect(isTypeaheadKey(ev('a', { altKey: true }))).toBe(false)
    expect(isTypeaheadKey(ev('a', { isComposing: true }))).toBe(false)
    expect(isTypeaheadKey(ev('ArrowDown'))).toBe(false)
    expect(isTypeaheadKey(ev('Enter'))).toBe(false)
  })

  it('accepts space only mid-query', () => {
    expect(isTypeaheadKey(ev(' '))).toBe(false)
    expect(isTypeaheadKey(ev(' '), 'new')).toBe(true)
  })
})

describe('usetypeahead', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accumulates and resets after the timeout', () => {
    vi.useFakeTimers()
    const ta = useTypeahead({ timeout: 500 })
    expect(ta.push('a')).toBe('a')
    vi.advanceTimersByTime(400)
    expect(ta.push('b')).toBe('ab') // timer restarted
    vi.advanceTimersByTime(400)
    expect(ta.current()).toBe('ab')
    vi.advanceTimersByTime(100)
    expect(ta.current()).toBe('')
    ta.push('x')
    ta.reset()
    expect(ta.current()).toBe('')
  })
})
