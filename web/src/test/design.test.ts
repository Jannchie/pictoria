import { describe, expect, it } from 'vitest'

// Design-system guard rails. The visual language lives in design tokens
// (`--p-*` in src/styles/tokens.css) and the in-house UI primitives in
// src/ui. These tests statically sweep every component source so a stray
// hard-coded colour, gradient, raw z-index or oversized shadow can't quietly
// drift back in. Mirrors the static-scan approach of locale.test.ts.

// Components carry their styling, so the sweep is scoped to .vue files only.
// Pulling in .ts would add false positives (hex literals in non-style code,
// data values, etc.) without catching anything the .vue scan misses, because
// every style rule and utility class lives in a component template/<style>.
const sources = import.meta.glob([
  '../**/*.vue',
  '!../test/**',
  '!../api/**',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// Normalise the glob's import.meta keys ("../components/Foo.vue") to a stable
// short name ("components/Foo.vue") for allowlists and error messages.
function shortName(file: string): string {
  return file.replace(/^\.\.\//, '')
}

function baseName(file: string): string {
  return file.split('/').pop() ?? file
}

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
  it('scans the component tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40)
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

  it('no .vue uses a gradient background', () => {
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

// 4. shadow-lg is the PSurface top elevation tier and must stay confined to
//    the ui/ primitives that define the elevation system. Feature components
//    (components/, views/, App.vue) should use lower tiers / PSurface.
describe('shadow-lg stays in the ui/ elevation primitives', () => {
  const SHADOW = /shadow-lg/g

  it('no shadow-lg outside src/ui', () => {
    const violations = findViolations(SHADOW, (file) => {
      // Only ui/ primitives (e.g. PSurface) may define the shadow-lg tier.
      return shortName(file).startsWith('ui/')
    })
    expect(violations, 'shadow-lg outside src/ui (use a lower PSurface tier)').toEqual([])
  })
})
