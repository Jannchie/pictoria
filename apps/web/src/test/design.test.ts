import { describe, expect, it } from 'vitest'

// Design-system guard rails. The visual language lives in design tokens
// (`--p-*` in src/styles/tokens.css) and the in-house UI primitives in
// src/ui. These tests statically sweep every component source so a stray
// hard-coded colour, gradient, raw z-index or oversized shadow can't quietly
// drift back in. Mirrors the static-scan approach of locale.test.ts.

// Normalise the glob's import.meta keys ("../components/Foo.vue") to a stable
// short name ("components/Foo.vue") for allowlists and error messages.
function shortName(file: string): string {
  return file.replace(/^\.\.\//, '')
}

function baseName(file: string): string {
  return file.split('/').pop() ?? file
}

// Vitest hands every CSS module over as an empty string — `?raw` included — so a
// glob of .css files would sweep nothing. Read those from disk instead (the glob
// keys are paths relative to this file). `fs` comes from getBuiltinModule rather
// than `import 'node:fs'`: the app's tsconfig has no Node types, and a
// `/// <reference types="node" />` here would leak them into the whole program.
const { readFileSync } = (globalThis as unknown as {
  process: { getBuiltinModule: (id: 'node:fs') => { readFileSync: (path: URL, encoding: 'utf8') => string } }
}).process.getBuiltinModule('node:fs')

function withCssFromDisk(globbed: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(globbed).map(([file, text]) =>
    [file, file.endsWith('.css') ? readFileSync(new URL(file, import.meta.url), 'utf8') : text]))
}

// Everything that can carry a style: components, the .ts modules that hold class
// names and colour tables (shared/ratings.ts, the UnoCSS shortcuts), and the
// stylesheets. The token definition file (styles/tokens.css) is the one place
// literal values belong, so it is left out.
const sources = withCssFromDisk(import.meta.glob([
  '../**/*.vue',
  '../**/*.ts',
  '../**/*.css',
  '../../uno.config.ts',
  '!../**/*.d.ts',
  '!../test/**',
  '!../api/**',
  '!../styles/tokens.css',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

// Collect "<short file> — <matched snippet>" lines for every match of
// `pattern` not excused by `isAllowed(file, matchText)`.
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
      // Trim the surrounding line so the failure message points at the spot.
      const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1
      const lineEndRaw = text.indexOf('\n', m.index ?? 0)
      const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
      const line = text.slice(lineStart, lineEnd).trim()
      out.push(`${shortName(file)} — ${line}`)
    }
  }
  return out.sort()
}

// Sentinel against the glob silently matching nothing (which would make every
// test below pass vacuously): the app has dozens of components.
describe('design-system source sweep', () => {
  it('scans components, .ts modules, stylesheets and uno.config.ts', () => {
    const files = Object.keys(sources)
    expect(files.filter(f => f.endsWith('.vue')).length).toBeGreaterThan(40)
    expect(files.some(f => f.endsWith('shared/ratings.ts'))).toBe(true)
    expect(files.some(f => f.endsWith('.css'))).toBe(true)
    expect(files.some(f => f.endsWith('uno.config.ts'))).toBe(true)
  })
})

// 1. No hard-coded hex colours — colours must come from design tokens
//    (`--p-*` / theme classes). The allowlist holds genuine *data* values
//    (fallbacks for runtime-computed colours), keyed by base file name →
//    set of permitted hex literals.
describe('no hard-coded hex colours', () => {
  const HEX = /#[0-9a-f]{3,8}\b/gi

  // file (base name) → hex literals that are data, not styling.
  const ALLOW: Record<string, Set<string>> = {
    // labToRgbaString() fallback when a post has no computed dominant colour.
    'PostDetailPanel.vue': new Set(['#000000']),
    // Default colour swatch before the user picks a sort colour.
    'PostSorter.vue': new Set(['#ffffff']),
    // RATING_LEVEL_COLORS / SCORE_LEVEL_COLORS: the per-level ramps, still
    // hard-coded. Known debt, listed so the next hex in this file is not free.
    'ratings.ts': new Set(['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444']),
  }

  it('every hex literal is a token or an allowlisted data value', () => {
    const violations = findViolations(HEX, (file, m) => {
      const allowed = ALLOW[baseName(file)]
      return allowed?.has(m[0].toLowerCase()) ?? false
    })
    expect(violations, 'hard-coded hex colours (use --p-* tokens instead)').toEqual([])
  })
})

// 2. No CSS gradients — flat token-driven surfaces only. Note: we deliberately
//    avoid a bare `from-` pattern, which would false-match Vue transition
//    `*-enter-from` / `*-leave-from` classes.
describe('no gradients', () => {
  const GRADIENT = /bg-gradient-|linear-gradient\(|radial-gradient\(|conic-gradient\(/g

  it('nothing uses a gradient background', () => {
    const violations = findViolations(GRADIENT, () => false)
    expect(violations, 'gradients are not part of the design system').toEqual([])
  })
})

// 3. No raw z-index above the "local stacking" threshold (10). Layering must
//    go through the `--p-z-*` scale (z-[var(--p-z-popup)] / var(--p-z-*) in
//    scoped style). Values <= 10 are local stacking nudges and tolerated.
describe('no raw z-index above the local-stacking threshold', () => {
  const THRESHOLD = 10
  // Utility class `z-200` and CSS `z-index: 200`.
  const Z = /\bz-(\d+)\b|z-index:\s*(\d+)/g

  // file (base name) → raw z values that are knowingly exempt (with reason).
  const ALLOW: Record<string, Set<number>> = {
    // Skip link, deliberately parked just below --p-z-popup so it surfaces
    // over content but never over popups (see tokens.css comment).
    'App.vue': new Set([9999]),
    // Comment-only reference to POverlay's z-40 in PSelectArea's docstring —
    // not a style rule. Allowlisted to keep the regex simple.
    'PSelectArea.vue': new Set([40]),
  }

  it('every raw z-index > 10 is on the --p-z-* scale or allowlisted', () => {
    const violations = findViolations(Z, (file, m) => {
      const value = Number(m[1] ?? m[2])
      if (value <= THRESHOLD) {
        return true
      }
      return ALLOW[baseName(file)]?.has(value) ?? false
    })
    expect(violations, 'raw z-index > 10 (use z-[var(--p-z-*)] / var(--p-z-*))').toEqual([])
  })
})

// 4. Reserved shadows (lg/xl/2xl) must stay confined to the ui/ primitives
//    that define the elevation system. `uno.config.ts` only defines sm/md/lg
//    as tokens; shadow-lg is the PSurface top tier, and shadow-xl/2xl fall
//    through to wind4 defaults (bypassing the token scale entirely). Feature
//    components (components/, views/, App.vue) should use lower tiers / PSurface.
describe('reserved shadows stay in the ui/ elevation primitives', () => {
  const SHADOW = /shadow-(lg|xl|2xl)\b/g

  it('no reserved shadow outside src/ui', () => {
    const violations = findViolations(SHADOW, (file) => {
      // Only ui/ primitives (e.g. PSurface) may use the shadow-lg tier;
      // uno.config.ts is where the scale maps onto its `--p-shadow-*` tokens.
      return shortName(file).startsWith('ui/') || file.endsWith('uno.config.ts')
    })
    expect(violations, 'reserved shadow (lg/xl/2xl) outside src/ui (use sm/md)').toEqual([])
  })
})

// 5. Every `var(--p-*)` names a token that is defined. An undefined
//    custom property resolves to nothing, so the declaration silently drops
//    (e.g. `--p-border-default` is a UnoCSS theme *key*, not a variable, and
//    `--p-bg-subtle` never existed). "Defined" means any of:
//    - a declaration `--p-x: …` in CSS / a scoped <style> / an inline style
//      string / a UnoCSS arbitrary property `[--p-x:…]`;
//    - `el.style.setProperty('--p-x', …)` from script;
//    - an object key `'--p-x': …` in a `:style` binding.
describe('every referenced --p-* token is defined', () => {
  const tokenSources = withCssFromDisk(import.meta.glob([
    '../**/*.vue',
    '../**/*.ts',
    '../**/*.css',
    '../../uno.config.ts',
    '!../**/*.d.ts',
    '!../test/**',
    '!../api/**',
  ], { query: '?raw', import: 'default', eager: true }) as Record<string, string>)

  const DECLARED = /(--p-[\w-]+)\s*:/g
  const SET_PROPERTY = /setProperty\(\s*['"`](--p-[\w-]+)['"`]/g
  const STYLE_KEY = /['"`](--p-[\w-]+)['"`]\s*:/g
  const REFERENCED = /var\(\s*(--p-[\w-]+)/g

  it('scans the token file and uno.config.ts', () => {
    const files = Object.keys(tokenSources)
    expect(files.some(f => f.endsWith('styles/tokens.css'))).toBe(true)
    expect(files.some(f => f.endsWith('uno.config.ts'))).toBe(true)
  })

  function definedIn(text: string): Set<string> {
    return new Set([DECLARED, SET_PROPERTY, STYLE_KEY].flatMap(pattern => [...text.matchAll(pattern)].map(m => m[1])))
  }

  // A token is defined in the token file, or — a component's private one
  // (PButton's `--p-btn-h`) — in the file that reads it. A declaration anywhere
  // else does not count: it would let one stray `--p-x:` (even in a comment)
  // excuse every `var(--p-x)` in the app.
  it('no var(--p-*) without a definition', () => {
    const tokenFile = Object.entries(tokenSources).find(([file]) => file.endsWith('styles/tokens.css'))![1]
    const tokens = definedIn(tokenFile)
    // Sanity: the token file was actually read.
    expect(tokens.has('--p-bg')).toBe(true)

    const violations: string[] = []
    for (const [file, text] of Object.entries(tokenSources)) {
      const local = definedIn(text)
      for (const m of text.matchAll(REFERENCED)) {
        const name = m[1]
        if (tokens.has(name) || local.has(name)) {
          continue
        }
        violations.push(`${shortName(file)} — ${name}`)
      }
    }
    expect(violations.sort(), 'var(--p-*) references an undefined token').toEqual([])
  })
})

// 6. No literal colour functions — `rgb(248 113 113)` is a hard-coded colour
//    just like `#f87171`. Colours go through tokens: `var(--p-*)`, or
//    `rgb(var(--p-*-rgb) / α)` for an alpha step. Only a numeric first
//    argument counts as a literal, so `rgb(var(…))` and runtime-built
//    `rgb(${…})` strings pass.
describe('no literal rgb()/hsl() colours', () => {
  const COLOR_FN = /\b(?:rgba?|hsla?)\(\s*[\d.]/gi

  it('every colour function takes a token', () => {
    const violations = findViolations(COLOR_FN, () => false)
    expect(violations, 'literal rgb()/hsl() colours (use var(--p-*) or rgb(var(--p-*-rgb) / α))').toEqual([])
  })
})

// 7. UnoCSS only extracts class names from the files in `content.pipeline.include`,
//    and plain .ts is not in its default set. An icon class that lives in a .ts
//    module (an option table's `icon: 'i-tabler-…'`) renders as nothing unless
//    that file is listed in uno.config.ts — silently, with no build error.
describe('every .ts carrying icon classes is in the unocss pipeline', () => {
  const ICON = /\bi-tabler-[a-z0-9-]+/

  it('uno.config.ts includes each such file', () => {
    const unoConfig = Object.entries(sources).find(([file]) => file.endsWith('uno.config.ts'))![1]
    const carriers = Object.entries(sources)
      .filter(([file, text]) => file.endsWith('.ts') && !file.endsWith('uno.config.ts') && ICON.test(text))
      .map(([file]) => `src/${shortName(file)}`)
    expect(carriers.length).toBeGreaterThan(0)
    expect(carriers.filter(file => !unoConfig.includes(`'${file}'`)), 'add to content.pipeline.include in uno.config.ts').toEqual([])
  })
})
