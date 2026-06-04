import { describe, expect, it } from 'vitest'
import { pickLocale } from '@/locale'
import en from '@/locale/messages/en'
import zhHans from '@/locale/messages/zh-Hans'

type Messages = Record<string, unknown>

function flatten(obj: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      out.set(path, v)
    }
    else {
      for (const [p, s] of flatten(v as Messages, path)) {
        out.set(p, s)
      }
    }
  }
  return out
}

function params(s: string): Set<string> {
  return new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))
}

const enFlat = flatten(en)
const zhFlat = flatten(zhHans)

// MessageSchema already enforces this at compile time; the runtime check
// guards against the type constraint ever being bypassed (e.g. `as any`).
describe('locale catalogues', () => {
  it('zh-hans mirrors the en key tree exactly', () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort())
  })

  it('zh-hans only references interpolation params that exist in en', () => {
    for (const [key, zhMessage] of zhFlat) {
      const enParams = params(enFlat.get(key) ?? '')
      for (const p of params(zhMessage)) {
        expect(enParams, `param {${p}} of "${key}" missing from en`).toContain(p)
      }
    }
  })

  it('no catalogue message is empty', () => {
    for (const [key, message] of [...enFlat, ...zhFlat]) {
      expect(message.trim(), `empty message for "${key}"`).not.toBe('')
    }
  })
})

// A typo'd key passes the type checker (t() takes any string) and silently
// renders the raw key at runtime — so statically sweep every literal key in
// the source tree and assert it resolves in the catalogue.
describe('catalogue covers every key used in source', () => {
  const sources = import.meta.glob([
    '../**/*.vue',
    '../**/*.ts',
    '../**/*.tsx',
    '!../test/**',
    '!../api/**',
  ], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  // Literal keys reach vue-i18n three ways: direct t('…')/$t('…') calls,
  // <i18n-t keypath="…">, and option arrays carrying labelKey/fullKey fields
  // that templates resolve via $t(opt.labelKey).
  const KEY_PATTERNS = [
    /\bt\(\s*'([a-z0-9.]+)'/gi,
    /keypath="([a-z0-9.]+)"/gi,
    /(?:labelKey|fullKey):\s*'([a-z0-9.]+)'/g,
  ]

  it('every literal i18n key in src/ exists in the en catalogue', () => {
    const missing = new Map<string, string>()
    let found = 0
    for (const [file, text] of Object.entries(sources)) {
      for (const pattern of KEY_PATTERNS) {
        for (const m of text.matchAll(pattern)) {
          const key = m[1]
          // Only dotted paths are message keys; bare words ('pictoria.locale'
          // style storage keys never reach t()) are filtered by the lookup.
          if (!key.includes('.')) {
            continue
          }
          found += 1
          if (!enFlat.has(key)) {
            missing.set(key, file)
          }
        }
      }
    }
    // Sentinel against the glob silently matching nothing (which would make
    // this test pass vacuously): the app uses hundreds of keys.
    expect(Object.keys(sources).length).toBeGreaterThan(50)
    expect(found).toBeGreaterThan(100)
    expect([...missing.entries()].map(([k, f]) => `${k} (${f})`), 'keys used in source but absent from en catalogue').toEqual([])
  })
})

describe('picklocale', () => {
  it('maps any zh variant to zh-hans', () => {
    expect(pickLocale(['zh-CN'])).toBe('zh-Hans')
    expect(pickLocale(['zh-TW'])).toBe('zh-Hans')
    expect(pickLocale(['zh'])).toBe('zh-Hans')
  })

  it('maps en variants to en', () => {
    expect(pickLocale(['en-US'])).toBe('en')
    expect(pickLocale(['en-GB', 'zh-CN'])).toBe('en')
  })

  it('skips unsupported languages until a supported one appears', () => {
    expect(pickLocale(['ja-JP', 'zh-CN'])).toBe('zh-Hans')
  })

  it('falls back to en when nothing matches', () => {
    expect(pickLocale(['ja-JP'])).toBe('en')
    expect(pickLocale([])).toBe('en')
  })
})
