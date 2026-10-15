import { describe, expect, it } from 'vitest'

// src/ui is the design system: primitives that know nothing about the app.
// They may use utils (pure helpers), vue-i18n's `t` for their own fixed strings,
// and the locale-aware formatters — but never app state. Importing from
// @/shared, @/composables, @/components or @/views (or the @/utils barrel, which
// re-exports app state) is how the old cycle ui/modal → shared/layers →
// shared/state → ui/modal formed, and how a "primitive" ended up bound to the
// global locale setting.
//
// Allowed from @/locale: `formatNumber` / `formatDateTime` only. They read the
// resolved locale the way `t` does (PTreeList renders row counts with it); the
// locale *setting* and anything else under @/locale is app state.

const sources = import.meta.glob(['../ui/**/*.vue', '../ui/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const FORBIDDEN = /from\s*['"]@\/(?:shared|composables|components|views|utils)['"/]/
const LOCALE_IMPORT = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"]@\/locale['"]/g
const LOCALE_ALLOWED = new Set(['formatNumber', 'formatDateTime'])

function utilsBarrelOrAppImport(line: string): boolean {
  // @/utils/<file> is fine (focus, keyboard, …); the bare @/utils barrel is not.
  if (/from\s*['"]@\/utils\//.test(line)) {
    return false
  }
  return FORBIDDEN.test(line)
}

describe('ui primitives do not depend on the app layer', () => {
  it('scans src/ui', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
  })

  it('no import from @/shared, @/composables, @/components, @/views or the @/utils barrel', () => {
    const violations: string[] = []
    for (const [file, text] of Object.entries(sources)) {
      for (const line of text.split('\n')) {
        if (/^\s*(?:import|export)\b/.test(line) && utilsBarrelOrAppImport(line)) {
          violations.push(`${file.replace(/^\.\.\//, '')} — ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('from @/locale only the formatters', () => {
    const violations: string[] = []
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(LOCALE_IMPORT)) {
        const names = m[2]!.split(',').map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean)
        for (const name of names.filter(n => !LOCALE_ALLOWED.has(n))) {
          violations.push(`${file.replace(/^\.\.\//, '')} — ${name}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
