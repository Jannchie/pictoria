import { useLocalStorage } from '@vueuse/core'
import { computed, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import en from './messages/en'
import zhHans from './messages/zh-Hans'

export const SUPPORTED_LOCALES = ['en', 'zh-Hans'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export type LocaleSetting = AppLocale | 'auto'

// Persisted user choice; 'auto' follows the browser language.
export const localeSetting = useLocalStorage<LocaleSetting>('pictoria.locale', 'auto')

// Pure resolver (exported for tests): first browser language that maps to a
// supported locale wins; anything unrecognised falls back to English.
export function pickLocale(langs: readonly string[]): AppLocale {
  for (const lang of langs) {
    const lower = lang.toLowerCase()
    if (lower.startsWith('zh')) {
      return 'zh-Hans'
    }
    if (lower.startsWith('en')) {
      return 'en'
    }
  }
  return 'en'
}

export const resolvedLocale = computed<AppLocale>(() =>
  localeSetting.value === 'auto'
    ? pickLocale(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language])
    : localeSetting.value,
)

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: resolvedLocale.value,
  fallbackLocale: 'en',
  messages: {
    'en': en,
    'zh-Hans': zhHans,
  },
})

// Keep vue-i18n, <html lang>, and any Intl formatter below in sync with the
// resolved locale. Module-scope watcher: the locale is app-lifetime state.
// flush: 'sync' so code reading i18n.global right after a setting change
// (including tests) sees the new locale immediately.
watch(resolvedLocale, (locale) => {
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}, { immediate: true, flush: 'sync' })

// ── Locale-aware formatting ──────────────────────────────────────────────
// Shared replacements for the previously hardcoded `Intl.NumberFormat('en-US')`
// instances and bare `toLocaleString()` calls. Both locale tags are valid
// BCP 47, so they feed straight into Intl.

const numberFormat = computed(() => new Intl.NumberFormat(resolvedLocale.value))

export function formatNumber(n: number): string {
  return numberFormat.value.format(n)
}

// Memoised like numberFormat: `toLocaleString`/`toLocaleDateString` construct a fresh
// Intl formatter per call, which shows up when a list formats a date per row — the
// annotation history re-renders every row on every judgement.
const dateTimeFormat = computed(() => new Intl.DateTimeFormat(resolvedLocale.value, { dateStyle: 'medium', timeStyle: 'medium' }))
const dateFormat = computed(() => new Intl.DateTimeFormat(resolvedLocale.value, { dateStyle: 'medium' }))

export function formatDateTime(input: string | number | Date): string {
  return dateTimeFormat.value.format(new Date(input))
}

export function formatDate(input: string | number | Date): string {
  return dateFormat.value.format(new Date(input))
}

const relativeFormat = computed(() => new Intl.RelativeTimeFormat(resolvedLocale.value, { numeric: 'auto' }))

// Largest unit first: pick the coarsest one the gap fills, so 90 minutes reads
// "1 hour ago" rather than "90 minutes ago".
// SECOND is also the fallback: a sub-second gap matches nothing and reads as "now".
const SECOND: [Intl.RelativeTimeFormatUnit, number] = ['second', 1]
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  SECOND,
]

/** "2 minutes ago" / "2 分钟前", in the active locale. Past-only in practice. */
export function formatRelativeTime(input: string | number | Date, now: number = Date.now()): string {
  const seconds = (new Date(input).getTime() - now) / 1000
  const magnitude = Math.abs(seconds)
  const [unit, size] = RELATIVE_UNITS.find(([, s]) => magnitude >= s) ?? SECOND
  return relativeFormat.value.format(Math.round(seconds / size), unit)
}
