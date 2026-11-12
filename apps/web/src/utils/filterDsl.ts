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
 *   silva:best|good|normal|bad|worst|unscored   also the A..E letters
 *
 * Everything is additive within a facet (`rating:g rating:s` = both), matching
 * how the popovers behave. There is deliberately no negation syntax: the
 * backend filter has no exclusion fields, and a term that silently did nothing
 * would be worse than not offering it.
 */
// 这个文件只管**词法**：分词、比较运算符、离散区间展开、rating 别名。哪个键对应
// 哪个字段、怎么解析/输出，在 `@/shared/postFilter` 的字段表里（唯一一处）。

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

/** Expands a comparison against a discrete 0..max scale into its members. */
export function expandRange(op: string, n: number, max: number): number[] {
  const all = Array.from({ length: max + 1 }, (_, i) => i)
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
export function splitOp(raw: string): [string, string] {
  // Not a regex: `\s*(.*)` lets both halves claim the same spaces, which is an
  // ambiguous split the engine has to back out of. startsWith + trimStart says the
  // same thing with no backtracking. Two-char operators must be tried first.
  const op = OPERATORS.find(o => raw.startsWith(o))
  return op ? [op, raw.slice(op.length).trimStart()] : ['', raw]
}
