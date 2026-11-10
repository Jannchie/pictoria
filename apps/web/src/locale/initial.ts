// The part of locale resolution main.ts needs before anything else loads.
// Dependency-free on purpose (no vue, no vue-i18n, no catalogue): it sits in
// the tiny entry chunk, so a zh session's catalogue request starts while the
// app chunk is still downloading instead of after it has been evaluated.
import type en from './messages/en'

export const SUPPORTED_LOCALES = ['en', 'zh-Hans', 'zh-Hant'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocaleSetting = AppLocale | 'auto'

/** localStorage key of the persisted choice (`useLocalStorage` stores the bare string). */
export const LOCALE_STORAGE_KEY = 'pictoria.locale'

// Regions and scripts that write traditional Chinese. Taiwan, Hong Kong and
// Macau are matched by region because that is what browsers actually send --
// `zh-TW`, `zh-HK` -- while `zh-Hant` is the explicit script subtag. Everything
// else under `zh` (including bare `zh` and `zh-CN`) is simplified: guessing
// traditional for an unqualified `zh` would serve the wrong script to the
// larger audience.
const TRADITIONAL = /^zh-(?:hant|tw|hk|mo)\b/

// Pure resolver (exported for tests): first browser language that maps to a
// supported locale wins; anything unrecognised falls back to English.
export function pickLocale(langs: readonly string[]): AppLocale {
  for (const lang of langs) {
    const lower = lang.toLowerCase()
    if (TRADITIONAL.test(lower)) {
      return 'zh-Hant'
    }
    if (lower.startsWith('zh')) {
      return 'zh-Hans'
    }
    if (lower.startsWith('en')) {
      return 'en'
    }
  }
  return 'en'
}

/** The browser's languages, for `auto`. */
export function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]
}

// English ships in the main bundle; the other catalogues are split chunks.
// Both the preload below and loadLocaleMessages (index.ts) go through these
// same `import()`s, so a preloaded catalogue is the module they get — the
// browser fetches it once.
export const MESSAGE_LOADERS: Record<Exclude<AppLocale, 'en'>, () => Promise<{ default: typeof en }>> = {
  'zh-Hans': () => import('./messages/zh-Hans'),
  'zh-Hant': () => import('./messages/zh-Hant'),
}

/** The locale the session starts in, read straight from storage (what `resolvedLocale` will say). */
export function initialLocale(): AppLocale {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY)
  }
  catch {
    // Storage blocked: fall through to the browser language.
  }
  return SUPPORTED_LOCALES.includes(stored as AppLocale) ? stored as AppLocale : pickLocale(browserLanguages())
}

/** Start fetching the starting locale's catalogue; main.ts calls this first thing. */
export function preloadInitialLocale(): void {
  const locale = initialLocale()
  if (locale !== 'en') {
    // Failure is loadLocaleMessages' to handle (it retries and falls back).
    MESSAGE_LOADERS[locale]().catch(() => {})
  }
}
