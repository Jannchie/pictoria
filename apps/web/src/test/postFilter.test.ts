import type { ParsedFilter, PostFilterState, PostSortColumn, PostSortOrder } from '@/shared/postFilter'
import { describe, expect, it } from 'vitest'
import {
  applyParsedFilter,
  clearFilter,
  emptyFacets,
  FILTER_DSL_KEYS,
  FILTER_FACETS,
  filterChips,
  filterFromQuery,
  filterQuerySignature,
  filterToBody,
  filterToQuery,
  parseFilterQuery,
  searchPostsBody,
  stringifyFilterQuery,
  withoutFacetValue,
} from '@/shared/postFilter'
import { SCORERS } from '@/shared/scorers'
import golden from './fixtures/postFilter.golden.json'

/**
 * `fixtures/postFilter.golden.json` was recorded from the five hand-written
 * implementations this module replaced (state.ts URL sync, filterDsl,
 * useActiveFilters chips, queries.ts request body), with a recording `t` that
 * prints its arguments. Frozen: it pins the old behaviour, so don't regenerate it.
 */

const fakeT = (k: string, a?: unknown, b?: unknown) => `${k}|${JSON.stringify(a ?? null)}|${b ?? ''}`

type State = PostFilterState

describe('golden equivalence with the pre-refactor implementations', () => {
  it('parses the dsl the same way', () => {
    for (const { input, out } of golden.parse) {
      expect(parseFilterQuery(input), input).toEqual(out)
    }
  })

  it('stringifies the same way', () => {
    for (const { state, text, out } of golden.stringify) {
      expect(stringifyFilterQuery(state as State, text)).toBe(out)
    }
  })

  it('projects state onto the url query the same way', () => {
    for (const { state, sort, order, color, base, out } of golden.toQuery) {
      const query = filterToQuery({ filter: state as State, sort: sort as PostSortColumn, order: order as PostSortOrder, sortColor: color ?? undefined }, base)
      expect(query).toEqual(out)
    }
  })

  it('reads the url query the same way', () => {
    for (const { query, out } of golden.fromQuery) {
      const patch = filterFromQuery(query as Record<string, string | null | (string | null)[]>)
      const flat = { ...patch.filter, ...(patch.sort ? { sort: patch.sort } : {}), ...(patch.order ? { order: patch.order } : {}), ...(patch.sortColor ? { sortColor: patch.sortColor } : {}) }
      expect(flat).toEqual(out)
    }
  })

  it('builds the search request body the same way', () => {
    for (const { state, page, sort, order, seed, lab, out } of golden.body) {
      const body = searchPostsBody({
        filter: state as State,
        mode: page === '/random' ? 'random' : page === '/recently' ? 'recently' : 'default',
        sort: sort as PostSortColumn,
        sortOrder: order as PostSortOrder,
        seed,
        lab: lab as [number, number, number] | undefined,
      })
      expect(body).toEqual(out)
    }
  })

  it('describes the same chips', () => {
    for (const { state, text, color, out } of golden.chips) {
      const chips = filterChips({ filter: state as State, text, sortColor: color ?? undefined }, fakeT)
      expect(chips.map(({ id, icon, label }) => ({ id, icon, label }))).toEqual(out)
    }
  })
})

const SAMPLE: State = {
  ...emptyFacets(),
  rating: [1, 4],
  score: [0, 5],
  tags: ['long_hair', 'a,b', 'with space', '100%'],
  extension: ['png', ''],
  waifuScoreLevels: ['A', 'UNSCORED'],
  silvaScoreLevels: ['B'],
  silvaLunaScoreLevels: ['E'],
  waifuScoreRange: [2, 8],
}

describe('url round-trip', () => {
  it('fromquery(toquery(x)) restores every facet, the range and the sort', () => {
    const state = { filter: SAMPLE, sort: 'silva_luna_score' as const, order: 'asc' as const, sortColor: '#123456' }
    const patch = filterFromQuery(filterToQuery(state, {}) as Record<string, string>)
    expect({ ...emptyFacets(), ...patch.filter }).toEqual(SAMPLE)
    expect(patch.sort).toBe('silva_luna_score')
    expect(patch.order).toBe('asc')
    expect(patch.sortColor).toBe('#123456')
  })

  it('omits defaults and empty facets, keeps unrelated params', () => {
    const query = filterToQuery({ filter: { ...emptyFacets() }, sort: 'id', order: 'desc', sortColor: undefined }, { other: 'x', rating: '1' })
    expect(query).toEqual({ other: 'x' })
  })

  it('every facet is synced — the signature changes when any one does', () => {
    const base = { filter: { ...emptyFacets() } as State, sort: 'id' as const, order: 'desc' as const, sortColor: undefined }
    const before = filterQuerySignature(base).join('\u0000')
    for (const spec of FILTER_FACETS) {
      const filter = { ...emptyFacets(), [spec.field]: [spec.field === 'rating' || spec.field === 'score' ? 1 : 'A'] } as State
      expect(filterQuerySignature({ ...base, filter }).join('\u0000'), spec.field).not.toBe(before)
      expect(filterToQuery({ ...base, filter }, {})).toHaveProperty(spec.field)
    }
  })

  it('tolerates hand-edited query shapes', () => {
    expect(filterFromQuery({ rating: ['1,2', '3'], score: null }).filter).toEqual({ rating: [1, 2] })
  })
})

describe('dsl round-trip', () => {
  it('parse(stringify(x)) restores every facet', () => {
    // The "no extension" value ('') renders as a bare `ext:`, which the parser
    // reads as free text — a known pre-existing gap the golden test pins, so
    // it is left out of the round-trip sample.
    const source = { ...SAMPLE, extension: ['png'] }
    const parsed = parseFilterQuery(stringifyFilterQuery(source, 'sunset'))
    expect(parsed.text).toBe('sunset')
    for (const spec of FILTER_FACETS) {
      // `parseFilterQuery` normalises spaces in tags to underscores.
      const expected = spec.field === 'tags'
        ? source.tags.map(t => t.replaceAll(' ', '_'))
        : source[spec.field]
      expect(parsed[spec.field], spec.field).toEqual(expected)
    }
  })

  it('every scorer has a dsl key, and keys are unique', () => {
    for (const s of SCORERS) {
      expect(FILTER_DSL_KEYS.has(s.dslKey)).toBe(true)
      expect(parseFilterQuery(`${s.dslKey}:best`)[s.levelsField]).toEqual(['A'])
    }
    const all = FILTER_FACETS.flatMap(f => f.dslKeys)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('apply / clear / body', () => {
  const parsed: ParsedFilter = { ...emptyFacets(), rating: [2], silvaLunaScoreLevels: ['C'], text: 'x', unknown: [] }

  it('applying a parsed query writes every facet (regression: scorer fields were hard-coded)', () => {
    const current: State = { ...SAMPLE, folder: 'a/b' }
    const next = applyParsedFilter(current, parsed)
    for (const spec of FILTER_FACETS) {
      expect(next[spec.field], spec.field).toEqual(parsed[spec.field])
    }
    expect(next.folder).toBe('a/b')
    expect(next.waifuScoreRange).toEqual([2, 8])
    expect(next).not.toHaveProperty('text')
    expect(next).not.toHaveProperty('unknown')
  })

  it('clear empties every facet and the range but keeps the folder', () => {
    const next = clearFilter({ ...SAMPLE, folder: 'a' })
    expect(next).toEqual({ ...emptyFacets(), folder: 'a', waifuScoreRange: undefined })
  })

  it('withoutfacetvalue drops one value only', () => {
    expect(withoutFacetValue(SAMPLE, 'rating', 1).rating).toEqual([4])
    expect(withoutFacetValue(SAMPLE, 'rating', 1).score).toBe(SAMPLE.score)
  })

  it('filtertobody equals spreading the state', () => {
    for (const s of [SAMPLE, { ...SAMPLE, folder: 'x' }, { ...emptyFacets() }, { ...emptyFacets(), folder: undefined }]) {
      expect(filterToBody(s)).toEqual({ ...s })
    }
  })
})
