import type { AppLocale, LocaleSetting } from './initial'
import { useLocalStorage } from '@vueuse/core'
import { computed, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import { browserLanguages, LOCALE_STORAGE_KEY, MESSAGE_LOADERS, pickLocale } from './initial'
// English is the schema source (MessageSchema) and the fallback, so it ships in
// the main bundle; the other catalogues are split chunks loaded on demand.
import en from './messages/en'

export { pickLocale, SUPPORTED_LOCALES } from './initial'
export type { AppLocale, LocaleSetting } from './initial'

// Persisted user choice; 'auto' follows the browser language.
export const localeSetting = useLocalStorage<LocaleSetting>(LOCALE_STORAGE_KEY, 'auto')

export const resolvedLocale = computed<AppLocale>(() =>
  localeSetting.value === 'auto'
    ? pickLocale(browserLanguages())
    : localeSetting.value,
)

// No explicit generics (they drop the `legacy: false` inference); the schema
// and the locale union are inferred from `messages`. Only `en` is there at
// start — the cast states the locales `loadLocaleMessages` adds later (each
// catalogue is typed `MessageSchema` in its own file).
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en } as Record<AppLocale, typeof en>,
})

/** One entry per locale fetched or being fetched; a failed fetch drops its entry so the next call retries. */
const loads = new Map<AppLocale, Promise<void>>()

/** Whether a locale's catalogue is in vue-i18n — `setLocaleMessage` adds it to `availableLocales`. */
function isLoaded(locale: AppLocale): boolean {
  return i18n.global.availableLocales.includes(locale)
}

/** Fetch a locale's catalogue into vue-i18n (no-op once loaded; concurrent calls share one fetch). */
export function loadLocaleMessages(locale: AppLocale): Promise<void> {
  if (isLoaded(locale)) {
    return Promise.resolve()
  }
  let pending = loads.get(locale)
  if (!pending) {
    pending = MESSAGE_LOADERS[locale as Exclude<AppLocale, 'en'>]().then(({ default: messages }) => {
      i18n.global.setLocaleMessage(locale, messages)
    }, (error: unknown) => {
      loads.delete(locale)
      throw error
    })
    loads.set(locale, pending)
  }
  return pending
}

function applyLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

// Keep vue-i18n, <html lang>, and any Intl formatter below in sync with the
// resolved locale. Module-scope watcher: the locale is app-lifetime state.
// flush: 'sync' so code reading i18n.global right after a setting change
// (including tests) sees the new locale immediately — for a catalogue that is
// already loaded; a first switch to a locale applies once its chunk arrives.
watch(resolvedLocale, (locale) => {
  if (isLoaded(locale)) {
    applyLocale(locale)
    return
  }
  loadLocaleMessages(locale).then(() => {
    // Only if the user hasn't switched again while the chunk was in flight.
    if (resolvedLocale.value === locale) {
      applyLocale(locale)
    }
  }, () => {
    // Chunk failed to load: stay on the current catalogue (English fallback).
  })
}, { immediate: true, flush: 'sync' })

/**
 * Resolves once the initial locale's catalogue is in (or failed to load) —
 * boot.ts mounts after it, so a zh session never paints English first. The
 * fetch itself usually started earlier: main.ts kicks it off
 * (`preloadInitialLocale`) before the app chunk has even arrived.
 */
export const localeReady: Promise<void> = loadLocaleMessages(resolvedLocale.value).catch(() => {})

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

// Day + time without the year or seconds ("11/9 14:32", "11月9日 14:32"): for
// recency stamps where the date alone hides that two visits were hours apart.
const shortDateTimeFormat = computed(() => new Intl.DateTimeFormat(resolvedLocale.value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))

export function formatShortDateTime(input: string | number | Date): string {
  return shortDateTimeFormat.value.format(new Date(input))
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
