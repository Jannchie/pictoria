import { getCurrentScope, onScopeDispose } from 'vue'

/**
 * Typeahead for lists, menus and trees: typing jumps to the next item whose
 * label starts with what was typed.
 *
 * - {@link matchTypeahead} is the pure matcher.
 * - {@link useTypeahead} holds the typed buffer, cleared after `timeout` ms
 *   of inactivity.
 * - {@link isTypeaheadKey} says which keydowns feed it.
 */

function normalize(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase()
}

/**
 * Index of the item to jump to, or -1 when nothing matches. Case-insensitive,
 * NFKC-normalised (full-width `Ａ` ≡ `a`), leading whitespace of labels ignored.
 *
 * - Single character, or the same character repeated (`'a'`, `'aaa'`): the
 *   search starts *after* `startIndex` and wraps, so pressing `a` again
 *   cycles through every item starting with "a".
 * - Longer query (`'ab'`): the search starts *at* `startIndex` (inclusive) and
 *   wraps, so the current item stays put while it still matches the growing
 *   query.
 *
 * `startIndex` of -1 means "nothing active" → search from the start.
 */
export function matchTypeahead(labels: readonly string[], query: string, startIndex: number): number {
  const n = labels.length
  const q = normalize(query)
  if (n === 0 || q.length === 0) {
    return -1
  }
  const chars = [...q]
  const repeated = chars.every(c => c === chars[0])
  const needle = repeated ? chars[0] : q
  const start = startIndex < 0 || startIndex >= n ? -1 : startIndex
  // Offset 1..n (exclusive of start) for single-char, 0..n-1 for multi-char.
  const from = repeated ? 1 : 0
  const base = start === -1 ? 0 : start
  const firstOffset = start === -1 ? 0 : from
  for (let offset = firstOffset; offset < firstOffset + n; offset++) {
    const i = (base + offset) % n
    if (normalize(labels[i].trimStart()).startsWith(needle)) {
      return i
    }
  }
  return -1
}

/**
 * Whether a keydown should feed typeahead: a single printable character with
 * no Ctrl / Meta / Alt (Shift is fine — it's how capitals are typed), not
 * during IME composition. Space counts only while a query is in progress
 * (`buffer` non-empty); otherwise Space is left to activate the item.
 */
export function isTypeaheadKey(e: KeyboardEvent, buffer = ''): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
    return false
  }
  if ([...e.key ?? ''].length !== 1) {
    return false
  }
  if (e.key === ' ') {
    return buffer.length > 0
  }
  return true
}

export interface UseTypeaheadOptions {
  /** Inactivity (ms) after which the buffer resets. Default 500. */
  timeout?: number
}

export interface Typeahead {
  /** Appends `char` and returns the whole current buffer. */
  push: (char: string) => string
  /** Clears the buffer now. */
  reset: () => void
  /** The current buffer ('' when idle). */
  current: () => string
}

/**
 * Stateful typeahead buffer. Not reactive (it's consulted inside key
 * handlers only). The pending timer is cleared on scope dispose.
 *
 * @example
 * const ta = useTypeahead()
 * if (isTypeaheadKey(e, ta.current())) { const i = matchTypeahead(labels, ta.push(e.key), active) }
 */
export function useTypeahead(options: UseTypeaheadOptions = {}): Typeahead {
  const timeout = options.timeout ?? 500
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  function reset() {
    buffer = ''
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function push(char: string): string {
    buffer += char
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timer = setTimeout(reset, timeout)
    return buffer
  }

  if (getCurrentScope()) {
    onScopeDispose(reset)
  }

  return { push, reset, current: () => buffer }
}
