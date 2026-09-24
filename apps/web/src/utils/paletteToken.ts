import { BUCKETS } from '@/shared/buckets'
import { RATING_LEVEL_LABEL_KEYS, RATING_UNRATED_LABEL_KEY } from '@/shared/ratings'
import { SCORERS } from '@/shared/scorers'

/**
 * Caret-aware view of the command-palette input, for autocomplete.
 *
 * `filterDsl.tokenize` answers "what does this string mean"; this module
 * answers "which term is the user typing right now, and what could it become".
 * It works on character spans (not values) so a completion can replace exactly
 * the term under the caret and leave the rest of the expression untouched.
 */

export interface TokenSpan {
  /** Inclusive start offset in the input. */
  start: number
  /** Exclusive end offset in the input. */
  end: number
  /** Raw substring, quotes included. */
  raw: string
  /** Lower-cased text before the first colon, or `null` when there is no `key:`. */
  key: string | null
  /** Text after the colon (or the whole token when keyless), quotes stripped. */
  value: string
}

/** Whitespace-separated spans; a quoted run (`tag:"long hair"`) is one span. */
export function tokenSpans(input: string): TokenSpan[] {
  const spans: TokenSpan[] = []
  let start = -1
  let quote: string | null = null
  const flush = (end: number) => {
    if (start !== -1) {
      spans.push(makeSpan(input, start, end))
      start = -1
    }
  }
  // UTF-16 units, not code points: offsets must line up with input.slice().
  for (const [i, ch] of Array.from({ length: input.length }, (_, k) => input.charAt(k)).entries()) {
    if (quote) {
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (/\s/.test(ch)) {
      flush(i)
      continue
    }
    if (start === -1) {
      start = i
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
    }
  }
  flush(input.length)
  return spans
}

function unquote(s: string): string {
  return s.replaceAll(/["']/g, '')
}

function makeSpan(input: string, start: number, end: number): TokenSpan {
  const raw = input.slice(start, end)
  const idx = raw.indexOf(':')
  if (idx <= 0) {
    return { start, end, raw, key: null, value: unquote(raw) }
  }
  return { start, end, raw, key: raw.slice(0, idx).toLowerCase(), value: unquote(raw.slice(idx + 1)) }
}

/**
 * The span the caret is editing: the one that ends at, or contains, the caret.
 * A caret sitting on whitespace (just after a finished term + space) edits
 * nothing, so no completion is offered there.
 */
export function tokenAt(input: string, caret: number): TokenSpan | null {
  return tokenSpans(input).find(s => s.start < caret && caret <= s.end) ?? null
}

/**
 * Replaces `span` with `replacement` and guarantees exactly one space after it,
 * so the next term can be typed straight away. Returns the new caret position
 * (just past that space).
 */
export function replaceSpan(input: string, span: TokenSpan, replacement: string): { text: string, caret: number } {
  const before = input.slice(0, span.start)
  const after = input.slice(span.end).replace(/^\s+/, '')
  const text = `${before}${replacement} ${after}`
  return { text, caret: before.length + replacement.length + 1 }
}

/** Removes `span` and the whitespace it leaves behind. */
export function removeSpan(input: string, span: TokenSpan): string {
  const before = input.slice(0, span.start).replace(/\s+$/, '')
  const after = input.slice(span.end).replace(/^\s+/, '')
  return before && after ? `${before} ${after}` : `${before}${after}`
}

/** `tag:name`, quoted only when the name needs it. */
export function tagTerm(name: string): string {
  return /[\s"']/.test(name) ? `tag:"${name.replaceAll('"', '')}"` : `tag:${name}`
}

const TAG_KEYS = new Set(['tag', 't'])

/**
 * What to search tags for, given the term under the caret — or `null` when a
 * tag suggestion would be noise.
 *
 * - `tag:` / `t:` → its value, even empty (then: the most common tags).
 * - a bare word → that word: typing part of a tag name is the main way people
 *   look for one, and the suggestion turns it into a filter. Latin words need
 *   2+ characters (one letter matches half the vocabulary); one CJK character
 *   is already specific (`眼`). Pure numbers are skipped (scores / ids, not tags).
 */
export function tagSuggestQuery(span: TokenSpan | null): string | null {
  if (!span) {
    return null
  }
  if (span.key !== null) {
    return TAG_KEYS.has(span.key) ? span.value : null
  }
  const word = span.value
  const ascii = [...word].every(c => c.charCodeAt(0) < 128)
  if ((ascii && word.length < 2) || /^\d+$/.test(word)) {
    return null
  }
  return word
}

/** A static DSL completion: the term to insert and an i18n key describing it. */
export interface SyntaxCompletion {
  /** Text that replaces the term under the caret. */
  insert: string
  /** i18n message key for the description column. */
  descKey: string
  /** When true the term is complete (a space follows); otherwise it's a `key:` prefix to keep typing. */
  complete: boolean
}

/** Filter keys offered when a bare word is a prefix of one. Order = display order. */
export const FILTER_KEYS: readonly { key: string, descKey: string }[] = [
  { key: 'tag', descKey: 'command.keyTag' },
  { key: 'rating', descKey: 'command.keyRating' },
  { key: 'score', descKey: 'command.keyScore' },
  { key: 'ext', descKey: 'command.keyExt' },
  ...SCORERS.map(s => ({ key: s.dslKey, descKey: `command.key_${s.dslKey}` })),
]

const RATING_VALUES: readonly { value: string, descKey: string }[] = [
  { value: 'general', descKey: RATING_LEVEL_LABEL_KEYS[0] },
  { value: 'sensitive', descKey: RATING_LEVEL_LABEL_KEYS[1] },
  { value: 'questionable', descKey: RATING_LEVEL_LABEL_KEYS[2] },
  { value: 'explicit', descKey: RATING_LEVEL_LABEL_KEYS[3] },
  { value: 'unrated', descKey: RATING_UNRATED_LABEL_KEY },
]

const SCORE_VALUES: readonly { value: string, descKey: string }[] = [
  { value: '>=4', descKey: 'command.scoreAtLeast4' },
  { value: '5', descKey: 'command.scoreExactly5' },
  { value: '0', descKey: 'common.unscored' },
]

const EXT_VALUES = ['png', 'jpg', 'webp', 'gif', 'avif'] as const

function valuesFor(key: string): readonly { value: string, descKey: string }[] | null {
  switch (key) {
    case 'rating':
    case 'r': { return RATING_VALUES }
    case 'score':
    case 'sc': { return SCORE_VALUES }
    case 'ext':
    case 'extension': { return EXT_VALUES.map(v => ({ value: v, descKey: 'command.keyExt' })) }
    default: {
      if (SCORERS.some(s => s.dslKey === key)) {
        return BUCKETS.map(b => ({ value: b.alias, descKey: b.labelKey }))
      }
      return null
    }
  }
}

/**
 * Static completions for the term under the caret:
 * - a bare word that prefixes a filter key → `key:` (keep typing);
 * - `key:partial` for a known non-tag key → matching values (complete terms).
 * An exact, already-complete term yields nothing (nothing left to complete).
 */
export function syntaxCompletions(span: TokenSpan | null): SyntaxCompletion[] {
  if (!span) {
    return []
  }
  if (span.key === null) {
    const word = span.value.toLowerCase()
    if (!word) {
      return []
    }
    return FILTER_KEYS
      .filter(k => k.key.startsWith(word))
      .map(k => ({ insert: `${k.key}:`, descKey: k.descKey, complete: false }))
  }
  const values = valuesFor(span.key)
  if (!values) {
    return []
  }
  const partial = span.value.toLowerCase()
  const matches = values.filter(v => v.value.startsWith(partial))
  if (matches.length === 1 && matches[0].value === partial) {
    return []
  }
  return matches.map(v => ({ insert: `${span.key}:${v.value}`, descKey: v.descKey, complete: true }))
}

/**
 * Replacement for a key prefix (`ra` → `rating:`): no trailing space, caret
 * right after the colon so the value can be typed.
 */
export function replaceSpanKeepTyping(input: string, span: TokenSpan, replacement: string): { text: string, caret: number } {
  const before = input.slice(0, span.start)
  const after = input.slice(span.end)
  return { text: `${before}${replacement}${after}`, caret: before.length + replacement.length }
}

/**
 * Relevance of a tag to what was typed, lower = better: exact, prefix,
 * word-start (after `_` / space), substring of the tag name; for its
 * translation (the server matches both) only exact vs substring. Ties break
 * on count.
 */
export function tagMatchRank(tagName: string, translated: string | null | undefined, typed: string): number {
  const q = typed.trim().toLowerCase().replaceAll(' ', '_')
  if (!q) {
    return 0
  }
  const name = tagName.toLowerCase()
  if (name === q) {
    return 0
  }
  if (name.startsWith(q)) {
    return 1
  }
  if (name.includes(`_${q}`)) {
    return 2
  }
  if (name.includes(q)) {
    return 3
  }
  const tr = translated?.toLowerCase() ?? ''
  const t = typed.trim().toLowerCase()
  if (tr === t) {
    return 1
  }
  // No prefix tier for translations: in CJK "starts with" says little
  // (超长发 vs 长发公主) — count decides among substring hits.
  return tr.includes(t) ? 3 : 4
}

/**
 * Re-ranks server results (top-N by count) by {@link tagMatchRank}, then count,
 * dropping items that don't match `typed` at all — which is what stale results
 * from the previous keystroke look like while the next request is in flight.
 */
export function rankTagSuggestions<T extends { tagName: string, translatedName?: string | null, count: number }>(
  items: readonly T[],
  typed: string,
  limit: number,
): T[] {
  return items
    .map(item => ({ item, rank: tagMatchRank(item.tagName, item.translatedName, typed) }))
    .filter(x => x.rank < 4)
    .sort((a, b) => a.rank - b.rank || b.item.count - a.item.count)
    .slice(0, limit)
    .map(x => x.item)
}
