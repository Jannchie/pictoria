/**
 * A small text syntax for the gallery filter, so the whole narrowing can be
 * typed, read back, and shared as one string instead of living invisibly across
 * six separate popovers.
 *
 * Grammar (space-separated terms; unrecognised text falls through as the
 * semantic-search prompt):
 *
 *   rating:general|sensitive|questionable|explicit|unrated   also g|s|q|e, or 0..4
 *   score:4          score:>=4      score:<3      score:0     (0 = unscored)
 *   tag:1girl        tag:"long hair"
 *   ext:png
 *   waifu:best|good|normal|bad|worst
 *   silva:best|good|normal|bad|worst
 *   luna:best|good|normal|bad|worst
 *
 * Everything is additive within a facet (`rating:g rating:s` = both), matching
 * how the popovers behave. There is deliberately no negation syntax: the
 * backend filter has no exclusion fields, and a term that silently did nothing
 * would be worse than not offering it.
 */

export interface ParsedFilter {
  rating: number[]
  score: number[]
  tags: string[]
  extension: string[]
  waifu_score_levels: string[]
  silva_score_levels: string[]
  silva_luna_score_levels: string[]
  /** Leftover free text — the semantic-search prompt. */
  text: string
  /** Terms that looked like `key:value` but weren't understood. */
  unknown: string[]
}

export const RATING_ALIASES: Record<string, number> = {
  unrated: 0,
  none: 0,
  general: 1,
  g: 1,
  safe: 1,
  sensitive: 2,
  s: 2,
  questionable: 3,
  q: 3,
  explicit: 4,
  e: 4,
}

export const BUCKET_IDS = ['best', 'good', 'normal', 'bad', 'worst'] as const

const MAX_SCORE = 5

/** Expands a comparison against the discrete 0..5 score scale into members. */
function expandScore(op: string, n: number): number[] {
  const all = Array.from({ length: MAX_SCORE + 1 }, (_, i) => i)
  switch (op) {
    case '>=': { return all.filter(v => v >= n) }
    case '>': { return all.filter(v => v > n) }
    case '<=': { return all.filter(v => v <= n) }
    case '<': { return all.filter(v => v < n) }
    default: { return all.includes(n) ? [n] : [] }
  }
}

/** Same idea for ratings, which run 0..4. */
function expandRating(op: string, n: number): number[] {
  const all = [0, 1, 2, 3, 4]
  switch (op) {
    case '>=': { return all.filter(v => v >= n) }
    case '>': { return all.filter(v => v > n) }
    case '<=': { return all.filter(v => v <= n) }
    case '<': { return all.filter(v => v < n) }
    default: { return all.includes(n) ? [n] : [] }
  }
}

/**
 * Splits on whitespace but keeps `"quoted phrases"` (and the `key:"..."` form)
 * intact, so tags with spaces survive.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null
      }
      else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

const OPERATORS = ['>=', '<=', '>', '<'] as const

/** Pulls a leading comparison operator off a value (`>=4` → ['>=', '4']). */
function splitOp(raw: string): [string, string] {
  // Not a regex: `\s*(.*)` lets both halves claim the same spaces, which is an
  // ambiguous split the engine has to back out of. startsWith + trimStart says the
  // same thing with no backtracking. Two-char operators must be tried first.
  const op = OPERATORS.find(o => raw.startsWith(o))
  return op ? [op, raw.slice(op.length).trimStart()] : ['', raw]
}

function addUnique<T>(target: T[], values: T[]): void {
  for (const v of values) {
    if (!target.includes(v)) {
      target.push(v)
    }
  }
}

export function parseFilterQuery(input: string): ParsedFilter {
  const result: ParsedFilter = {
    rating: [],
    score: [],
    tags: [],
    extension: [],
    waifu_score_levels: [],
    silva_score_levels: [],
    silva_luna_score_levels: [],
    text: '',
    unknown: [],
  }
  const freeText: string[] = []

  for (const token of tokenize(input)) {
    const idx = token.indexOf(':')
    // No colon, or a colon at the very start/end — treat as free text.
    if (idx <= 0 || idx === token.length - 1) {
      freeText.push(token)
      continue
    }
    const key = token.slice(0, idx).toLowerCase()
    const rawValue = token.slice(idx + 1)
    const [op, value] = splitOp(rawValue)

    switch (key) {
      case 'rating':
      case 'r': {
        const alias = RATING_ALIASES[value.toLowerCase()]
        const n = alias ?? Number(value)
        if (Number.isFinite(n)) {
          addUnique(result.rating, expandRating(op, n))
        }
        else {
          result.unknown.push(token)
        }
        break
      }
      case 'score':
      case 'sc': {
        const n = Number(value)
        if (Number.isFinite(n)) {
          addUnique(result.score, expandScore(op, n))
        }
        else {
          result.unknown.push(token)
        }
        break
      }
      case 'tag':
      case 't': {
        // Tags are stored with underscores; accept spaces as the friendly form.
        addUnique(result.tags, [value.replaceAll(' ', '_')])
        break
      }
      case 'ext':
      case 'extension': {
        addUnique(result.extension, [value.toLowerCase().replace(/^\./, '')])
        break
      }
      case 'waifu': {
        const v = value.toLowerCase()
        if ((BUCKET_IDS as readonly string[]).includes(v)) {
          addUnique(result.waifu_score_levels, [v])
        }
        else {
          result.unknown.push(token)
        }
        break
      }
      case 'silva': {
        const v = value.toLowerCase()
        if ((BUCKET_IDS as readonly string[]).includes(v)) {
          addUnique(result.silva_score_levels, [v])
        }
        else {
          result.unknown.push(token)
        }
        break
      }
      case 'luna': {
        const v = value.toLowerCase()
        if ((BUCKET_IDS as readonly string[]).includes(v)) {
          addUnique(result.silva_luna_score_levels, [v])
        }
        else {
          result.unknown.push(token)
        }
        break
      }
      default: {
        result.unknown.push(token)
        // An unrecognised key is still words the user typed — keep it
        // searchable rather than swallowing it.
        freeText.push(token)
      }
    }
  }

  result.text = freeText.join(' ').trim()
  result.rating.sort((a, b) => a - b)
  result.score.sort((a, b) => a - b)
  return result
}

/** Inverse of the parser: renders live filter state back into the syntax. */
export function stringifyFilterQuery(filter: {
  rating: number[]
  score: number[]
  tags: string[]
  extension: string[]
  waifu_score_levels: string[]
  silva_score_levels: string[]
  silva_luna_score_levels: string[]
}, text = ''): string {
  const parts: string[] = []
  const ratingName = ['unrated', 'general', 'sensitive', 'questionable', 'explicit']

  for (const r of [...filter.rating].sort((a, b) => a - b)) {
    parts.push(`rating:${ratingName[r] ?? r}`)
  }
  for (const s of [...filter.score].sort((a, b) => a - b)) {
    parts.push(`score:${s}`)
  }
  for (const tag of filter.tags) {
    parts.push(tag.includes(' ') ? `tag:"${tag}"` : `tag:${tag}`)
  }
  for (const ext of filter.extension) {
    parts.push(`ext:${ext}`)
  }
  for (const lvl of filter.waifu_score_levels) {
    parts.push(`waifu:${lvl}`)
  }
  for (const lvl of filter.silva_score_levels) {
    parts.push(`silva:${lvl}`)
  }
  for (const lvl of filter.silva_luna_score_levels) {
    parts.push(`luna:${lvl}`)
  }
  const trimmed = text.trim()
  if (trimmed) {
    parts.push(trimmed)
  }
  return parts.join(' ')
}

/** True when the input contains at least one recognised `key:value` term. */
export function hasFilterTerms(parsed: ParsedFilter): boolean {
  return parsed.rating.length > 0
    || parsed.score.length > 0
    || parsed.tags.length > 0
    || parsed.extension.length > 0
    || parsed.waifu_score_levels.length > 0
    || parsed.silva_score_levels.length > 0
    || parsed.silva_luna_score_levels.length > 0
}
