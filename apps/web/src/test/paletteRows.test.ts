import { describe, expect, it } from 'vitest'
import { activeRowIndex, applyRowKind, groupSections, highlightRow, matchCommands, orderRows, termChips } from '@/utils/paletteRows'

describe('matchcommands', () => {
  const cmds = [
    { label: 'Sort by score', keywords: 'stars' },
    { label: 'Settings' },
  ]
  it('returns everything for an empty query', () => {
    expect(matchCommands(cmds, '  ')).toEqual(cmds)
  })
  it('matches label or keywords, case-insensitively', () => {
    expect(matchCommands(cmds, 'SET')).toEqual([cmds[1]])
    expect(matchCommands(cmds, 'star')).toEqual([cmds[0]])
  })
})

describe('applyrowkind', () => {
  const base = { hasTerms: false, promptText: '', query: '', seededQuery: '' }
  it('nothing to apply → no row', () => {
    expect(applyRowKind(base)).toBeNull()
  })
  it('all terms deleted from a filtered view → clear', () => {
    expect(applyRowKind({ ...base, seededQuery: 'rating:g ' })).toBe('clear')
  })
  it('untouched seeded input with no terms → no row', () => {
    expect(applyRowKind({ ...base, query: ' ', seededQuery: ' ' })).toBeNull()
  })
  it('terms, terms + text, text only', () => {
    expect(applyRowKind({ ...base, hasTerms: true })).toBe('filter')
    expect(applyRowKind({ ...base, hasTerms: true, promptText: 'cat' })).toBe('filterAndSearch')
    expect(applyRowKind({ ...base, promptText: 'cat' })).toBe('search')
  })
})

describe('orderrows', () => {
  const parts = { apply: 'A', syntax: ['S'], tags: ['T'], commands: ['C'], intro: ['I'] }
  it('bare word: apply leads, then completions, commands, intro', () => {
    expect(orderRows({ ...parts, typingKey: false })).toEqual(['A', 'S', 'T', 'C', 'I'])
  })
  it('typing a key: completions lead and commands are hidden', () => {
    expect(orderRows({ ...parts, typingKey: true })).toEqual(['S', 'T', 'A', 'I'])
  })
  it('no apply row', () => {
    expect(orderRows({ ...parts, apply: null, typingKey: false })).toEqual(['S', 'T', 'C', 'I'])
  })
})

describe('groupsections', () => {
  it('groups consecutive rows and keeps flat indices', () => {
    const rows = [{ section: 'apply' as const }, { section: 'tags' as const }, { section: 'tags' as const }, { section: 'sort' as const }]
    const sections = groupSections(rows, 'u')
    expect(sections.map(s => [s.key, s.labelId, s.items.map(i => i.index)])).toEqual([
      ['apply', 'u-sec-apply-0', [0]],
      ['tags', 'u-sec-tags-1', [1, 2]],
      ['sort', 'u-sec-sort-2', [3]],
    ])
  })
})

describe('activerowindex', () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  it('finds the active id, else falls back to the first row', () => {
    expect(activeRowIndex(rows, 'b')).toBe(1)
    expect(activeRowIndex(rows, 'gone')).toBe(0)
    expect(activeRowIndex(rows, null)).toBe(0)
  })
})

describe('termchips', () => {
  it('reads finished key:value terms back, naturalising tags', () => {
    const q = 'tag:long_hair rating:g cat '
    expect(termChips(q, q.length, []).map(c => [c.label, c.unknown])).toEqual([
      ['tag: long hair', false],
      ['rating: g', false],
    ])
  })
  it('skips the term still being typed at the caret', () => {
    const q = 'rating:g score:4'
    expect(termChips(q, q.length, []).map(c => c.label)).toEqual(['rating: g'])
  })
  it('flags unknown keys and parser-rejected values', () => {
    const q = 'colour:blue rating:purple silva:best '
    expect(termChips(q, q.length, ['rating:purple']).map(c => [c.label, c.unknown])).toEqual([
      ['colour: blue', true],
      ['rating: purple', true],
      ['silva: best', false],
    ])
  })
  it('matches quoted unknown terms with their quotes stripped', () => {
    const q = 'tag:"a b" '
    expect(termChips(q, q.length, ['tag:a b'])[0]!.unknown).toBe(true)
  })
})

describe('highlightrow', () => {
  it('drops the key prefix, quotes, and matches underscores as spaces', () => {
    expect(highlightRow('long hair', 'tag:"long_ha')).toEqual([
      { text: 'long ha', match: true },
      { text: 'ir', match: false },
    ])
  })
  it('no needle → the whole text unmatched', () => {
    expect(highlightRow('Settings')).toEqual([{ text: 'Settings', match: false }])
    expect(highlightRow('Settings', 'tag:')).toEqual([{ text: 'Settings', match: false }])
  })
})
