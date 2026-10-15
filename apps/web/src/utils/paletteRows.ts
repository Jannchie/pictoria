import type { HighlightPart } from './highlight'
import type { TokenSpan } from './paletteToken'
import { FILTER_DSL_KEYS } from '@/shared/postFilter'
import { splitHighlight } from './highlight'
import { tokenSpans } from './paletteToken'

/**
 * Pure row model of the command palette: which rows exist, in what order, how
 * they group into sections, which one is active, and how the typed terms read
 * back as chips. `CommandPalette.vue` owns the reactive wiring (queries,
 * caret, i18n, side effects); everything here is a function of its inputs.
 */

export type SectionKey = 'apply' | 'tags' | 'syntax' | 'filter' | 'navigate' | 'sort' | 'view' | 'help'

export interface PaletteRow {
  id: string
  section: SectionKey
  icon: string
  label: string
  /** Substring of `label` to emphasise (the part that matched the input). */
  match?: string
  /** Secondary text (translation, description). */
  hint?: string
  /** Right-aligned mono detail (a count). */
  meta?: string
  /** Shortcut in `useHotkey` grammar, rendered Mac-aware. */
  shortcut?: string
  /** Completion rows fill the input instead of closing the palette. */
  kind: 'command' | 'completion'
  /**
   * `enter` / `tab`: the row's primary action. `apply`: Mod+Enter — for a
   * completion, insert it and apply the whole query at once.
   */
  activate: (mode: 'enter' | 'tab' | 'apply') => void
}

export const SECTION_LABEL_KEYS: Record<SectionKey, string> = {
  apply: 'command.groupAction',
  tags: 'command.groupTags',
  syntax: 'command.groupSyntax',
  filter: 'command.groupFilter',
  navigate: 'command.groupNavigate',
  sort: 'command.groupSort',
  view: 'command.groupView',
  help: 'command.groupHelp',
}

/** Plain substring match on label or keywords — predictable beats clever for a 20-item list. */
export function matchCommands<T extends { label: string, keywords?: string }>(commands: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return [...commands]
  }
  return commands.filter(c =>
    c.label.toLowerCase().includes(q) || (c.keywords?.toLowerCase().includes(q) ?? false),
  )
}

/**
 * What the apply row offers, or `null` for no apply row:
 * - `clear`: every term was deleted from a filtered view;
 * - `filter` / `filterAndSearch`: there are filter terms (plus free text);
 * - `search`: only free text — a semantic search.
 */
export type ApplyRowKind = 'clear' | 'filter' | 'filterAndSearch' | 'search'

export function applyRowKind(opts: { hasTerms: boolean, promptText: string, query: string, seededQuery: string }): ApplyRowKind | null {
  const { hasTerms, promptText, query, seededQuery } = opts
  if (!hasTerms && !promptText) {
    const isDirty = query.trim() !== seededQuery.trim()
    return isDirty && seededQuery.trim() !== '' ? 'clear' : null
  }
  if (hasTerms) {
    return promptText ? 'filterAndSearch' : 'filter'
  }
  return 'search'
}

/**
 * Order follows intent. While a `key:` term is being typed, the completions
 * are what the user is after, so they lead; for a bare word the search /
 * apply row leads and the tag suggestions sit right under it. Syntax rows
 * precede tag rows: a key prefix (`ra` → `rating:`) is a stronger signal than
 * a tag that merely contains the letters. Mid-way through a `key:` term the
 * commands are noise — the user is writing a filter, not looking for "Sort by…".
 */
export function orderRows<R>(parts: {
  /** The term under the caret has a `key:`. */
  typingKey: boolean
  apply: R | null
  syntax: readonly R[]
  tags: readonly R[]
  commands: readonly R[]
  intro: readonly R[]
}): R[] {
  const apply = parts.apply ? [parts.apply] : []
  const completions = [...parts.syntax, ...parts.tags]
  const lead = parts.typingKey ? [...completions, ...apply] : [...apply, ...completions]
  const commands = parts.typingKey ? [] : parts.commands
  return [...lead, ...commands, ...parts.intro]
}

export interface RowSection<R> {
  key: SectionKey
  labelId: string
  items: { row: R, index: number }[]
}

/** Consecutive rows of one section share a group; `index` is the flat row index. */
export function groupSections<R extends { section: SectionKey }>(rows: readonly R[], idPrefix: string): RowSection<R>[] {
  const out: RowSection<R>[] = []
  for (const [index, row] of rows.entries()) {
    const last = out.at(-1)
    if (last && last.key === row.section) {
      last.items.push({ row, index })
    }
    else {
      out.push({ key: row.section, labelId: `${idPrefix}-sec-${row.section}-${out.length}`, items: [{ row, index }] })
    }
  }
  return out
}

/** The active row is tracked by id (so async updates don't move it); unknown / null → the first row. */
export function activeRowIndex(rows: readonly { id: string }[], activeId: string | null): number {
  const i = rows.findIndex(r => r.id === activeId)
  return i === -1 ? 0 : i
}

export interface TermChip {
  span: TokenSpan
  label: string
  unknown: boolean
}

function naturalize(tag: string): string {
  return tag.replaceAll('_', ' ')
}

/**
 * The understood `key:value` terms of the input, read back as chips. The term
 * whose end the caret sits on is still being typed, not a finished filter, so
 * it is left out. A chip is flagged unknown when its key isn't a filter key or
 * the parser rejected it (`unknownTerms`: the parser's `unknown`, which lists
 * terms as `tokenize()` yields them — quotes stripped).
 */
export function termChips(query: string, caret: number, unknownTerms: readonly string[]): TermChip[] {
  const spans = tokenSpans(query)
  // Same rule as tokenAt(): the span that ends at, or contains, the caret.
  const current = spans.find(s => s.start < caret && caret <= s.end)
  const unknown = new Set(unknownTerms)
  return spans
    .filter(s => s.key !== null && s.value !== '' && !(current?.start === s.start && caret === s.end))
    .map((s) => {
      const key = s.key!
      return {
        span: s,
        label: `${key}: ${key === 'tag' || key === 't' ? naturalize(s.value) : s.value}`,
        unknown: !FILTER_DSL_KEYS.has(key) || unknown.has(s.raw.replaceAll(/["']/g, '')),
      }
    })
}

/**
 * Highlight parts for a row label. The needle is the raw term under the caret,
 * so drop its `key:` prefix and quotes, and match tag underscores as spaces
 * (labels show naturalised tag names). Empty parts are dropped.
 */
export function highlightRow(text: string, needle?: string): HighlightPart[] {
  const n = needle?.replace(/^[a-z]+:/i, '').replaceAll(/["']/g, '').replaceAll('_', ' ') ?? ''
  return splitHighlight(text, n).filter(p => p.text)
}
