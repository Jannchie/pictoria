import { describe, expect, it } from 'vitest'
import { hasFilterTerms, parseFilterQuery, stringifyFilterQuery, tokenize } from '@/utils/filterDsl'

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('a b  c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps quoted phrases together', () => {
    expect(tokenize('tag:"long hair" red')).toEqual(['tag:long hair', 'red'])
  })

  it('handles single quotes', () => {
    expect(tokenize('tag:\'blue sky\'')).toEqual(['tag:blue sky'])
  })

  it('returns nothing for blank input', () => {
    expect(tokenize('   ')).toEqual([])
  })
})

describe('parsefilterquery — ratings', () => {
  it('accepts full names', () => {
    expect(parseFilterQuery('rating:explicit').rating).toEqual([4])
  })

  it('accepts single-letter aliases', () => {
    expect(parseFilterQuery('rating:g rating:s').rating).toEqual([1, 2])
  })

  it('accepts numbers', () => {
    expect(parseFilterQuery('rating:3').rating).toEqual([3])
  })

  it('maps unrated to 0', () => {
    // 0 is falsy — guards against `alias ?? Number(value)` regressions where a
    // `||` would fall through to NaN and drop the term.
    expect(parseFilterQuery('rating:unrated').rating).toEqual([0])
  })

  it('expands >= into every matching level', () => {
    expect(parseFilterQuery('rating:>=3').rating).toEqual([3, 4])
  })

  it('expands < into every matching level', () => {
    expect(parseFilterQuery('rating:<2').rating).toEqual([0, 1])
  })

  it('reports an unparseable value instead of silently filtering', () => {
    const parsed = parseFilterQuery('rating:purple')
    expect(parsed.rating).toEqual([])
    expect(parsed.unknown).toEqual(['rating:purple'])
  })
})

describe('parsefilterquery — scores', () => {
  it('takes an exact score', () => {
    expect(parseFilterQuery('score:4').score).toEqual([4])
  })

  it('expands >= across the 0..5 scale', () => {
    expect(parseFilterQuery('score:>=4').score).toEqual([4, 5])
  })

  it('expands < and includes the unscored bucket', () => {
    expect(parseFilterQuery('score:<2').score).toEqual([0, 1])
  })

  it('ignores an out-of-range exact score', () => {
    expect(parseFilterQuery('score:9').score).toEqual([])
  })
})

describe('parsefilterquery — tags, extensions, buckets', () => {
  it('converts spaces in tags to underscores', () => {
    expect(parseFilterQuery('tag:"long hair"').tags).toEqual(['long_hair'])
  })

  it('strips a leading dot from extensions and lowercases them', () => {
    expect(parseFilterQuery('ext:.PNG').extension).toEqual(['png'])
  })

  it('accepts known quality buckets', () => {
    const parsed = parseFilterQuery('waifu:best silva:worst luna:good')
    expect(parsed.waifu_score_levels).toEqual(['best'])
    expect(parsed.silva_score_levels).toEqual(['worst'])
    expect(parsed.silva_luna_score_levels).toEqual(['good'])
  })

  it('rejects an unknown bucket', () => {
    const parsed = parseFilterQuery('silva:amazing')
    expect(parsed.silva_score_levels).toEqual([])
    expect(parsed.unknown).toEqual(['silva:amazing'])
  })

  it('de-duplicates repeated terms', () => {
    expect(parseFilterQuery('tag:cat tag:cat').tags).toEqual(['cat'])
  })
})

describe('parsefilterquery — free text', () => {
  it('collects bare words as the search prompt', () => {
    const parsed = parseFilterQuery('girl in red dress')
    expect(parsed.text).toBe('girl in red dress')
    expect(hasFilterTerms(parsed)).toBe(false)
  })

  it('separates filter terms from the prompt', () => {
    const parsed = parseFilterQuery('sunset rating:>=3 beach')
    expect(parsed.text).toBe('sunset beach')
    expect(parsed.rating).toEqual([3, 4])
    expect(hasFilterTerms(parsed)).toBe(true)
  })

  it('keeps an unrecognised key as searchable text', () => {
    const parsed = parseFilterQuery('colour:blue')
    expect(parsed.text).toBe('colour:blue')
    expect(parsed.unknown).toEqual(['colour:blue'])
  })

  it('treats a trailing colon as plain text', () => {
    expect(parseFilterQuery('tag:').text).toBe('tag:')
  })

  it('treats a leading colon as plain text', () => {
    expect(parseFilterQuery(':foo').text).toBe(':foo')
  })
})

describe('stringifyfilterquery', () => {
  const empty = {
    rating: [],
    score: [],
    tags: [],
    extension: [],
    waifu_score_levels: [],
    silva_score_levels: [],
    silva_luna_score_levels: [],
  }

  it('renders an empty filter as an empty string', () => {
    expect(stringifyFilterQuery(empty)).toBe('')
  })

  it('names rating levels', () => {
    expect(stringifyFilterQuery({ ...empty, rating: [1, 4] })).toBe('rating:general rating:explicit')
  })

  it('quotes tags containing spaces', () => {
    expect(stringifyFilterQuery({ ...empty, tags: ['long hair'] })).toBe('tag:"long hair"')
  })

  it('appends the free-text prompt last', () => {
    expect(stringifyFilterQuery({ ...empty, score: [5] }, 'sunset')).toBe('score:5 sunset')
  })

  it('round-trips through the parser', () => {
    const source = {
      ...empty,
      rating: [3, 4],
      score: [5],
      tags: ['long_hair'],
      extension: ['png'],
      waifu_score_levels: ['best'],
      silva_score_levels: ['good'],
      silva_luna_score_levels: ['normal'],
    }
    const parsed = parseFilterQuery(stringifyFilterQuery(source, 'sunset'))
    expect(parsed.rating).toEqual(source.rating)
    expect(parsed.score).toEqual(source.score)
    expect(parsed.tags).toEqual(source.tags)
    expect(parsed.extension).toEqual(source.extension)
    expect(parsed.waifu_score_levels).toEqual(source.waifu_score_levels)
    expect(parsed.silva_score_levels).toEqual(source.silva_score_levels)
    expect(parsed.silva_luna_score_levels).toEqual(source.silva_luna_score_levels)
    expect(parsed.text).toBe('sunset')
  })
})
