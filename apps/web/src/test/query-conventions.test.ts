import { describe, expect, it } from 'vitest'

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

// 3. Facet count queries must be popover-gated. A `queryKeys.count(...)` query
//    with no `enabled:` gate refires for every facet whenever ANY filter
//    changes (each one's filterWithoutSelf embeds all the others), fanning a
//    single click into 6–8 full-table aggregates that queue on the API's one
//    synchronous sqlite connection — measured at ~850 ms of blocked event loop
//    per filter switch on the 223k library. The counts are only visible inside
//    an open popover, so every consumer must pass an `enabled` ref bound to it.
describe('facet count queries are gated', () => {
  it('every usequery keyed by querykeys.count also sets enabled', () => {
    const offenders: string[] = []
    for (const [file, text] of Object.entries(sources)) {
      if (!/queryKeys\.count\(/.test(text) || !/useQuery\(/.test(text)) {
        continue
      }
      if (!/enabled:/.test(text)) {
        offenders.push(shortName(file))
      }
    }
    expect(offenders, 'count query without an enabled: gate (bind it to the popover open state)').toEqual([])
  })
})
