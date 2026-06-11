/**
 * Score / rating bounds, mirroring the backend's single source of truth
 * (`server/src/shared.py`: `MAX_POST_SCORE`, `MAX_POST_RATING`). Keep these in
 * sync with the backend; the API validates against the same limits.
 *
 * Ratings run 0..MAX_POST_RATING (0 = unrated), scores 0..MAX_POST_SCORE
 * (0 = unscored), so a distribution has `MAX_* + 1` buckets.
 */

export const MAX_POST_RATING = 4
export const MAX_POST_SCORE = 5

/**
 * Per-level icon / colour for rating levels 1..MAX_POST_RATING (G/S/Q/E),
 * shared by the detail & multi-select rating selectors and the rating filter
 * button. This file is listed in uno.config's extraction pipeline so the icon
 * class names here are picked up by UnoCSS.
 */
export const RATING_LEVEL_ICONS = ['i-tabler-seeding', 'i-tabler-mood-heart', 'i-tabler-eye-off', 'i-tabler-eyeglass-off']
// Tailwind green/yellow/orange/red-500 — vivid enough to read on both themes
// (the CSS named colors they replaced were too murky on dark surfaces).
export const RATING_LEVEL_COLORS = ['#22c55e', '#eab308', '#f97316', '#ef4444']

/** Icon for the synthetic "unrated" bucket (rating 0) in the rating filter. */
export const RATING_UNRATED_ICON = 'i-tabler-star-off'

/**
 * i18n message keys for rating levels 1..MAX_POST_RATING (index 0 = level 1),
 * resolved with `t()` at render — same consumption pattern as the icon/colour
 * arrays above.
 */
export const RATING_LEVEL_LABEL_KEYS = ['rating.general', 'rating.sensitive', 'rating.questionable', 'rating.explicit']

/** Message key for the synthetic "unrated" bucket (rating 0). */
export const RATING_UNRATED_LABEL_KEY = 'rating.unrated'

/** One-letter abbreviations for rating levels 1..MAX_POST_RATING (G/S/Q/E). */
export const RATING_LEVEL_SHORT = ['G', 'S', 'Q', 'E']

/**
 * Quality ramp for the manual 1..MAX_POST_SCORE score: low = red → high =
 * green (index 0 is score 1). The multi-select distribution bar prepends a
 * muted colour for its unscored bucket.
 */
export const SCORE_LEVEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e']

/**
 * Waifu-scale (0–10) A–E bucket colour ramp: A/B green, C amber, D orange,
 * E red. Values are "r g b" channel triples (CSS var or literal) for use
 * inside `rgb(${...})` / `rgb(${...} / alpha)`. SILVA shares the ramp after
 * ×10 onto the same scale; folder stats feed it normalised ratios ×10.
 */
interface WaifuLevel {
  level: string
  min: number
  rgb: string
}
// The E bucket doubles as the find() floor for out-of-range inputs.
const WAIFU_LEVEL_FLOOR: WaifuLevel = { level: 'E', min: 0, rgb: 'var(--p-danger-rgb)' }
export const WAIFU_LEVEL_RGB: WaifuLevel[] = [
  { level: 'A', min: 8, rgb: 'var(--p-success-rgb)' },
  { level: 'B', min: 6, rgb: '90 190 90' },
  { level: 'C', min: 4, rgb: 'var(--p-warning-rgb)' },
  { level: 'D', min: 2, rgb: '235 125 45' },
  WAIFU_LEVEL_FLOOR,
]

/** The bucket entry for a waifu-scale (0–10) score. */
export function waifuLevel(score: number): WaifuLevel {
  return WAIFU_LEVEL_RGB.find(b => score >= b.min) ?? WAIFU_LEVEL_FLOOR
}

/** The "r g b" triple for a waifu-scale (0–10) score's bucket. */
export function waifuLevelRgb(score: number): string {
  return waifuLevel(score).rgb
}
