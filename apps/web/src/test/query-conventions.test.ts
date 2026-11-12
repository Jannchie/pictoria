import { QueryClient, useQuery } from '@tanstack/vue-query'
import { describe, expect, it } from 'vitest'
import { effectScope, isProxy, nextTick } from 'vue'
import { createQueryClient } from '@/shared/queryClient'
import { queryKeys } from '@/shared/queryKeys'

// Convention guard rails for TanStack Query usage and error handling.
// Mirrors the static-scan approach of design.test.ts / locale.test.ts: sweep
// the source tree so a stray inline query-key array or a silent console.error
// can't quietly drift back in.
//
// 1. Query keys must come from the `queryKeys` factory (src/shared/queryKeys.ts).
//    A hand-spelled `queryKey: [...]` re-introduces the exact typo/shape-drift
//    class the factory exists to prevent (a mismatched literal silently breaks
//    cache sharing/invalidation with no type error).
// 2. API/command failures must route through `useAPIError().handle` so the user
//    gets a consistent toast — a bare `console.error` swallows the failure
//    into the devtools. The single legitimate `console.error` is the central
//    logger inside useAPIError itself.

const sources = import.meta.glob([
  '../**/*.vue',
  '../**/*.ts',
  '!../**/*.d.ts',
  '!../test/**',
  '!../api/**',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function shortName(file: string): string {
  return file.replace(/^\.\.\//, '')
}

function baseName(file: string): string {
  return file.split('/').pop() ?? file
}

// Collect "<short file> — <matched line>" for every match not excused by
// isAllowed(file, match).
function findViolations(
  pattern: RegExp,
  isAllowed: (file: string, match: RegExpMatchArray) => boolean,
): string[] {
  const out: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(pattern)) {
      if (isAllowed(file, m)) {
        continue
      }
      const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1
      const lineEndRaw = text.indexOf('\n', m.index ?? 0)
      const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
      out.push(`${shortName(file)} — ${text.slice(lineStart, lineEnd).trim()}`)
    }
  }
  return out.sort()
}

// Sentinel against the glob silently matching nothing (which would make every
// test below pass vacuously).
describe('query-conventions source sweep', () => {
  it('scans the source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40)
  })
})

// 1. Query keys go through the factory — no inline array literals.
describe('no inline querykey arrays', () => {
  const INLINE_KEY = /queryKey:\s*\[/g

  it('every querykey references the querykeys factory (no `querykey: [...]`)', () => {
    const violations = findViolations(INLINE_KEY, () => false)
    expect(violations, 'inline queryKey arrays (build the key via queryKeys.* in src/shared/queryKeys.ts)').toEqual([])
  })
})

// 2. No bare console.error — route failures through useAPIError().handle.
describe('no stray console.error', () => {
  const CONSOLE_ERROR = /console\.error/g

  // The one legitimate logger: useAPIError's central handler.
  const ALLOW = new Set(['useAPIError.ts'])

  it('no console.error outside the central useapierror handler', () => {
    const violations = findViolations(CONSOLE_ERROR, file => ALLOW.has(baseName(file)))
    expect(violations, 'bare console.error (route failures through useAPIError().handle)').toEqual([])
  })
})

// 3. Facet count queries must be popover-gated — spread `gatedCountOptions`
//    from useFacetFilter.ts, which owns the gate and the measured rationale
//    (an ungated count refires for every facet on any filter change).
describe('facet count queries are gated', () => {
  const COUNT_KEY = /queryKeys\.count\(/g

  it('every file querying by querykeys.count spreads gatedcountoptions', () => {
    const violations = findViolations(COUNT_KEY, (file) => {
      const text = sources[file]!
      // Excused: no useQuery in the file (key-factory / invalidation sites),
      // or the query already spreads the shared gated options.
      return !/useQuery\(/.test(text) || /gatedCountOptions\(/.test(text)
    })
    expect(violations, 'count query without gatedCountOptions (spread it from useFacetFilter.ts)').toEqual([])
  })
})

// 4. Writes go through shared/mutations.ts — the one place that pairs each write
//    endpoint with its cache invalidation. A component calling a write endpoint
//    directly is how invalidations went missing (score computation refreshed the
//    post but not the facet counts; annotations never refreshed per-post history).
//
//    "Write" is derived from the generated SDK rather than kept as a list of
//    names, so a newly generated endpoint is classified without anyone
//    remembering to: every non-GET endpoint is a write, minus the POSTs that only
//    read (they take a filter body), plus the GETs that persist something. Both
//    exception lists are checked against the SDK below, so a renamed or
//    re-methoded endpoint fails loudly instead of silently changing class.
describe('write endpoints are called only from shared/mutations.ts', () => {
  const sdk = Object.values(import.meta.glob('../api/sdk.gen.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0] ?? ''
  const METHOD = /^export const (v2\w+) = .*?\.(get|post|put|patch|delete)</gm
  const methods = new Map([...sdk.matchAll(METHOD)].map(m => [m[1]!, m[2]!]))

  /** POST endpoints that only read (search / facet counts / stats take a filter body). */
  const READ_ONLY_POSTS = new Set([
    'v2SearchPosts',
    'v2SearchPostsByText',
    'v2GetPostsCount',
    'v2GetPostsStats',
    'v2GetRatingCount',
    'v2GetScoreCount',
    'v2GetExtensionCount',
    'v2GetTagCount',
    'v2GetSilvaBucketCount',
  ])
  /** GET endpoints that compute and persist (the per-post scorers). */
  const WRITING_GETS = new Set(['v2GetSilvaScorerOne'])

  const writes = new Set([...methods].filter(([name, method]) =>
    method === 'get' ? WRITING_GETS.has(name) : !READ_ONLY_POSTS.has(name)).map(([name]) => name))

  // The owner of every write.
  const OWNER = 'shared/mutations.ts'
  // Files frozen until the PostFilter / scorer refactor that still call a write
  // endpoint directly (待 PostFilter 重构). Empty today: CommandPalette and the
  // facet filters only call read endpoints. Add an entry here — never a write
  // import elsewhere — if a frozen file must keep one for a while.
  const PENDING_POSTFILTER_REFACTOR = new Set<string>()

  it('parses the generated sdk', () => {
    expect(methods.size).toBeGreaterThan(40)
    expect(writes.has('v2DeletePosts')).toBe(true)
    expect(writes.has('v2SearchPosts')).toBe(false)
  })

  it('the exception lists match the sdk', () => {
    for (const name of READ_ONLY_POSTS) {
      expect(methods.get(name), `${name} should be a POST in sdk.gen.ts`).toBe('post')
    }
    for (const name of WRITING_GETS) {
      expect(methods.get(name), `${name} should be a GET in sdk.gen.ts`).toBe('get')
    }
  })

  it('no file outside shared/mutations.ts imports a write endpoint', () => {
    const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@\/api(?:\/sdk\.gen)?['"]/g
    const violations: string[] = []
    for (const [file, text] of Object.entries(sources)) {
      const name = shortName(file)
      if (name === OWNER || PENDING_POSTFILTER_REFACTOR.has(name)) {
        continue
      }
      for (const m of text.matchAll(IMPORT)) {
        const imported = m[1]!.split(',')
          .map(s => s.trim())
          .filter(s => s && !s.startsWith('type '))
          .map(s => s.split(/\s+as\s+/)[0]!.trim())
        for (const endpoint of imported.filter(n => writes.has(n))) {
          violations.push(`${name} — ${endpoint}`)
        }
      }
    }
    expect(violations.sort(), 'write endpoint imported outside shared/mutations.ts (add a function there that also invalidates)').toEqual([])
  })
})

// 5. The tag taxonomy is a static table (apps/api/src/tag-tree.ts reads
//    server/data/tag-tree.json once per process). Its key must stay outside the
//    `tags` catalogue prefix, or every tag add/remove (writeTag invalidates
//    tagsRoot) refetches the whole tree for nothing.
describe('tag tree key is not under the tags prefix', () => {
  it('invalidating tagsroot leaves the tag tree fresh', async () => {
    const qc = new QueryClient()
    qc.setQueryData(queryKeys.tagTree(), [])
    qc.setQueryData(queryKeys.tags(), [])
    await qc.invalidateQueries({ queryKey: queryKeys.tagsRoot })
    expect(qc.getQueryState(queryKeys.tagTree())?.isInvalidated).toBe(false)
    expect(qc.getQueryState(queryKeys.tags())?.isInvalidated).toBe(true)
  })
})

// 6. Query data is shallow app-wide (createQueryClient in shared/queryClient.ts):
//    `data` is the cached object itself, not a deep reactive proxy. That holds
//    only while nobody edits query data in place — a cache write must hand the
//    cache a new reference (setQueryData / setQueriesData returning a copy).
describe('query data is shallow', () => {
  it('the app query client defaults every query to shallow', () => {
    // query-core types the defaults without the vue-only `shallow` option.
    const queries = createQueryClient().getDefaultOptions().queries as { shallow?: boolean } | undefined
    expect(queries?.shallow).toBe(true)
  })

  it('a query under that client hands back the raw cached object', async () => {
    const qc = createQueryClient()
    const cached = { pages: [[{ id: 1 }]] }
    qc.setQueryData(queryKeys.postGroup(1), cached)
    const scope = effectScope()
    const data = scope.run(() => useQuery({ queryKey: queryKeys.postGroup(1), queryFn: () => cached, staleTime: Infinity }, qc).data)!
    await nextTick()
    expect(isProxy(data.value)).toBe(false)
    expect(data.value).toBe(cached)
    scope.stop()
  })

  it('no per-query `shallow: true` (the default covers it)', () => {
    const violations = findViolations(/\bshallow:\s*true/g, file => baseName(file) === 'queryClient.ts')
    expect(violations, 'redundant per-query shallow: true (createQueryClient sets it for every query)').toEqual([])
  })

  // Static, so only the direct spelling: an assignment or mutating array call
  // through `<something>.data.value` / a destructured `data.value`. Writes
  // through a renamed destructure or a local alias are not caught.
  it('no in-place writes through a query\'s data ref', () => {
    const ACCESS = String.raw`\bdata\.value(?:\??\.[\w$]+|\[[^\]\n]+\])*`
    const ASSIGN = new RegExp(String.raw`${ACCESS}(?:\??\.[\w$]+|\[[^\]\n]+\])\s*(?:[-+*/]?=(?!=)|\+\+|--)`, 'g')
    const MUTATE = new RegExp(String.raw`${ACCESS}\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\(`, 'g')
    const violations = [...findViolations(ASSIGN, () => false), ...findViolations(MUTATE, () => false)]
    expect(violations, 'query data edited in place (replace it through queryClient.setQueryData instead)').toEqual([])
  })
})
