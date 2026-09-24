import { describe, expect, it } from 'vitest'
import {
  rankTagSuggestions,
  removeSpan,
  replaceSpan,
  replaceSpanKeepTyping,
  syntaxCompletions,
  tagSuggestQuery,
  tagTerm,
  tokenAt,
  tokenSpans,
} from '@/utils/paletteToken'

function at(s: string) {
  return tokenAt(s, s.length)
}

describe('tokenspans', () => {
  it('splits on whitespace and keeps quoted runs together', () => {
    const spans = tokenSpans('rating:g  tag:"long hair" cat')
    expect(spans.map(s => s.raw)).toEqual(['rating:g', 'tag:"long hair"', 'cat'])
    expect(spans[1]).toMatchObject({ key: 'tag', value: 'long hair', start: 10, end: 25 })
    expect(spans[2]).toMatchObject({ key: null, value: 'cat' })
  })

  it('treats a leading colon as keyless', () => {
    expect(tokenSpans(':x')[0]).toMatchObject({ key: null, value: ':x' })
  })
})

describe('tokenat', () => {
  it('finds the term ending at the caret', () => {
    expect(tokenAt('rating:g hai', 12)?.raw).toBe('hai')
    expect(tokenAt('rating:g hai', 5)?.raw).toBe('rating:g')
  })

  it('returns null on whitespace after a finished term', () => {
    expect(tokenAt('rating:g ', 9)).toBeNull()
    expect(tokenAt('', 0)).toBeNull()
  })
})

describe('replacespan / removespan', () => {
  it('replaces the term and leaves one space after it', () => {
    const input = 'rating:g hai score:5'
    const span = tokenAt(input, 12)!
    expect(replaceSpan(input, span, 'tag:long_hair')).toEqual({ text: 'rating:g tag:long_hair score:5', caret: 23 })
  })

  it('appends a trailing space at the end of the input', () => {
    const span = tokenAt('hai', 3)!
    expect(replaceSpan('hai', span, 'tag:hair')).toEqual({ text: 'tag:hair ', caret: 9 })
  })

  it('keeps typing after a key prefix', () => {
    const span = tokenAt('ra', 2)!
    expect(replaceSpanKeepTyping('ra', span, 'rating:')).toEqual({ text: 'rating:', caret: 7 })
  })

  it('removes a term and collapses whitespace', () => {
    const input = 'a tag:x b'
    expect(removeSpan(input, tokenSpans(input)[1])).toBe('a b')
    expect(removeSpan(input, tokenSpans(input)[0])).toBe('tag:x b')
    expect(removeSpan(input, tokenSpans(input)[2])).toBe('a tag:x')
  })
})

describe('tagterm', () => {
  it('quotes only when needed', () => {
    expect(tagTerm('long_hair')).toBe('tag:long_hair')
    expect(tagTerm('long hair')).toBe('tag:"long hair"')
  })
})

describe('tagsuggestquery', () => {
  it('searches the value of tag: terms, even when empty', () => {
    expect(tagSuggestQuery(at('tag:ha'))).toBe('ha')
    expect(tagSuggestQuery(at('t:'))).toBe('')
  })

  it('searches bare words of 2+ chars, but not numbers', () => {
    expect(tagSuggestQuery(at('hai'))).toBe('hai')
    expect(tagSuggestQuery(at('绿眼'))).toBe('绿眼')
    expect(tagSuggestQuery(at('h'))).toBeNull()
    expect(tagSuggestQuery(at('眼'))).toBe('眼')
    expect(tagSuggestQuery(at('42'))).toBeNull()
  })

  it('ignores other keys and empty positions', () => {
    expect(tagSuggestQuery(at('rating:g'))).toBeNull()
    expect(tagSuggestQuery(null)).toBeNull()
  })
})

describe('syntaxcompletions', () => {
  it('offers keys for a bare prefix', () => {
    expect(syntaxCompletions(at('ra')).map(c => c.insert)).toEqual(['rating:'])
    expect(syntaxCompletions(at('s')).map(c => c.insert)).toEqual(['score:', 'silva:'])
  })

  it('offers values after a known key', () => {
    expect(syntaxCompletions(at('rating:')).map(c => c.insert)).toEqual([
      'rating:general',
      'rating:sensitive',
      'rating:questionable',
      'rating:explicit',
      'rating:unrated',
    ])
    expect(syntaxCompletions(at('silva:b')).map(c => c.insert)).toEqual(['silva:best', 'silva:bad'])
  })

  it('offers nothing for a finished term or tag values', () => {
    expect(syntaxCompletions(at('rating:general'))).toEqual([])
    expect(syntaxCompletions(at('tag:ha'))).toEqual([])
  })
})

describe('ranktagsuggestions', () => {
  const items = [
    { tagName: 'braid', count: 30_000 },
    { tagName: 'rating_x', count: 10 },
    { tagName: 'long_hair', count: 180_000 },
    { tagName: 'hair_ornament', count: 80_000 },
    { tagName: 'green_eyes', translatedName: '绿眼', count: 50_000 },
    { tagName: 'eyes', translatedName: '眼睛', count: 1000 },
  ]
  it('puts prefix matches before substring matches, then count', () => {
    expect(rankTagSuggestions(items, 'hair', 10).map(i => i.tagName).slice(0, 2)).toEqual(['hair_ornament', 'long_hair'])
    expect(rankTagSuggestions(items, 'ra', 10)[0].tagName).toBe('rating_x')
  })
  it('ranks translation hits exact first, then by count', () => {
    expect(rankTagSuggestions(items, '眼', 10).map(i => i.tagName)).toEqual(['green_eyes', 'eyes'])
    expect(rankTagSuggestions(items, '眼睛', 10).map(i => i.tagName)).toEqual(['eyes'])
  })
  it('limits the result', () => {
    expect(rankTagSuggestions(items, '', 2)).toHaveLength(2)
  })
  it('drops candidates that no longer match (stale results)', () => {
    expect(rankTagSuggestions(items, 'hair', 10).map(i => i.tagName)).toEqual(['hair_ornament', 'long_hair'])
  })
})
