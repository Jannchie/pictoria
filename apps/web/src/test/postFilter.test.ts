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
  isPostSortColumn,
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
 *
 * When the waifu and silva_luna scorers were retired the recording was projected
 * (mechanically, not re-recorded) onto what still exists: their fields, DSL
 * terms and chips were dropped, and the one non-default sort column it used
 * (the waifu one) became `silva_score`. The `fromQuery` inputs still carry the
 * retired params on purpose — they pin that a stale URL is ignored.
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
  silvaScoreLevels: ['B', 'UNSCORED'],
}

describe('url round-trip', () => {
  it('fromquery(toquery(x)) restores every facet and the sort', () => {
    const state = { filter: SAMPLE, sort: 'silva_score' as const, order: 'asc' as const, sortColor: '#123456' }
    const patch = filterFromQuery(filterToQuery(state, {}) as Record<string, string>)
    expect({ ...emptyFacets(), ...patch.filter }).toEqual(SAMPLE)
    expect(patch.sort).toBe('silva_score')
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

// Bookmarks made before the waifu / silva_luna scorers were retired.
describe('stale urls', () => {
  const STALE = {
    rating: '1',
    waifuScoreLevels: 'A,UNSCORED',
    silvaLunaScoreLevels: 'C',
    waifuScoreRange: '2,8',
  }

  it('ignores the params of filters that no longer exist', () => {
    expect(filterFromQuery(STALE)).toEqual({ filter: { rating: [1] } })
  })

  it('ignores a sort column that no longer exists instead of adopting it', () => {
    for (const sort of ['waifu_score', 'silva_luna_score', 'nonsense', '', 'toString']) {
      expect(filterFromQuery({ sort, order: 'asc' }), sort).toEqual({ filter: {}, order: 'asc' })
    }
    // /recently's forced column is not a user choice either.
    expect(filterFromQuery({ sort: 'last_accessed_at' }).sort).toBeUndefined()
    expect(filterFromQuery({ sort: 'silva_score' }).sort).toBe('silva_score')
  })

  it('ignores an order that is neither asc nor desc', () => {
    expect(filterFromQuery({ sort: 'score', order: 'sideways' })).toEqual({ filter: {}, sort: 'score' })
  })

  it('a stale url never reaches the request body', () => {
    // What `useSyncFilterWithUrl` does with the patch, from the default state.
    const patch = filterFromQuery({ ...STALE, sort: 'waifu_score' })
    const body = searchPostsBody({
      filter: { ...emptyFacets(), ...patch.filter },
      mode: 'default',
      sort: patch.sort ?? 'id',
      sortOrder: patch.order ?? 'desc',
      seed: 1,
    })
    expect(body).toEqual({ ...emptyFacets(), rating: [1], order: 'desc', orderBy: 'id' })
  })

  it('knows which stored sort columns are still valid', () => {
    expect(isPostSortColumn('silva_score')).toBe(true)
    expect(isPostSortColumn('id')).toBe(true)
    for (const stale of ['waifu_score', 'silva_luna_score', 'last_accessed_at', undefined, null, 3]) {
      expect(isPostSortColumn(stale), String(stale)).toBe(false)
    }
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
  const parsed: ParsedFilter = { ...emptyFacets(), rating: [2], silvaScoreLevels: ['C'], text: 'x', unknown: [] }

  it('applying a parsed query writes every facet (regression: scorer fields were hard-coded)', () => {
    const current: State = { ...SAMPLE, folder: 'a/b' }
    const next = applyParsedFilter(current, parsed)
    for (const spec of FILTER_FACETS) {
      expect(next[spec.field], spec.field).toEqual(parsed[spec.field])
    }
    expect(next.folder).toBe('a/b')
    expect(next).not.toHaveProperty('text')
    expect(next).not.toHaveProperty('unknown')
  })

  it('clear empties every facet but keeps the folder', () => {
    const next = clearFilter({ ...SAMPLE, folder: 'a' })
    expect(next).toEqual({ ...emptyFacets(), folder: 'a' })
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
