import { formatDate, formatRelativeTime, formatShortDateTime } from '@/locale'
import { RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, SCORE_LEVEL_COLORS, waifuLevelRgb } from '@/shared/ratings'

/** The top-right value badge on a gallery tile: text or an icon, optionally in a level colour. */
export interface SortBadge {
  text?: string
  icon?: string
  color?: string
}

const DAY_MS = 24 * 3600 * 1000

/**
 * A "last viewed" stamp: relative within the last day ("3 hours ago"), else
 * day + time. The plain date the other columns use made a whole /recently
 * page read "today" on every tile.
 */
function formatAccessTime(v: number | string, now: number = Date.now()): string {
  const t = new Date(v).getTime()
  return now - t < DAY_MS && now >= t ? formatRelativeTime(t, now) : formatShortDateTime(t)
}

/**
 * Badge for a tile's `sortValue` under the gallery's effective sort column
 * (`sort`), or undefined when that column gets no badge.
 */
export function formatSortValue(sort: string, v: number | string, now: number = Date.now()): SortBadge | undefined {
  switch (sort) {
    case 'score': {
      const n = Number(v)
      return { text: String(v), color: SCORE_LEVEL_COLORS[n - 1] }
    }
    // Rating levels show as their sidebar-selector icon, in the same colour.
    case 'rating': {
      const n = Number(v)
      return n >= 1 && n <= RATING_LEVEL_ICONS.length
        ? { icon: RATING_LEVEL_ICONS[n - 1], color: RATING_LEVEL_COLORS[n - 1] }
        : { text: '—' }
    }
    case 'waifu_score': {
      const n = Number(v)
      return { text: n.toFixed(2), color: `rgb(${waifuLevelRgb(n)})` }
    }
    // The SILVA heads store 0–1; surface them on the same 0–10 scale (and
    // bucket colour ramp) as the detail panel's WaifuScoreLevel chip.
    case 'silva_score':
    case 'silva_luna_score': {
      const n = Number(v) * 10
      return { text: n.toFixed(2), color: `rgb(${waifuLevelRgb(n)})` }
    }
    // |silva − manual| on the 1-5 scale: bigger means model & human disagree
    // more. Flagged in the danger colour so the worst offenders pop in the grid.
    case 'discrepancy': {
      return { text: Number(v).toFixed(2), color: 'var(--p-danger)' }
    }
    case 'created_at':
    case 'published_at':
    case 'updated_at': {
      return { text: formatDate(v) }
    }
    case 'last_accessed_at': {
      return { text: formatAccessTime(v, now) }
    }
    // file_name is not worth a badge (the grid is pictures, not a listing);
    // id is the "no particular sort" default — no badge for either.
    default: {
      return undefined
    }
  }
}
