import { matchesShortcut } from '@/utils/keyboard'

/**
 * Keyboard cursor arithmetic for an APG "combobox + listbox" where DOM focus
 * stays in the text input and the active option is tracked by index (exposed
 * through `aria-activedescendant`). Used by the command palette and the tag
 * selector.
 *
 * Key model (decided once for both):
 * - ArrowDown / ArrowUp: next / previous option, wrapping at the ends.
 * - PageDown / PageUp: ±`pageSize`, clamped (no wrap).
 * - Ctrl+Home / Ctrl+End (⌘ on Mac too): first / last option, always.
 * - Home / End: first / last option ONLY while the input is empty — with text
 *   in it they keep their native job of moving the caret (APG combobox).
 *
 * Enter / Escape are not cursor moves and stay with the caller.
 */
export interface ListboxKeyContext {
  /** Current active index; -1 = nothing active yet. */
  index: number
  count: number
  /** True while the combobox input holds no text (enables bare Home/End). */
  inputEmpty?: boolean
  /** Rows per PageUp/PageDown. Default 10. */
  pageSize?: number
}

/**
 * Returns the new active index for a cursor key, or `null` when the key is
 * not a listbox cursor key (let it through). An empty list returns `null`
 * too, so the caller never swallows keys it can't act on.
 */
export function listboxKeyIndex(e: KeyboardEvent, ctx: ListboxKeyContext): number | null {
  const { index, count } = ctx
  const pageSize = ctx.pageSize ?? 10
  if (count <= 0 || e.isComposing) {
    return null
  }
  if (matchesShortcut(e, 'ArrowDown')) {
    return index < 0 ? 0 : (index + 1) % count
  }
  if (matchesShortcut(e, 'ArrowUp')) {
    return index < 0 ? count - 1 : (index - 1 + count) % count
  }
  if (matchesShortcut(e, 'PageDown')) {
    return Math.min(count - 1, Math.max(0, index) + pageSize)
  }
  if (matchesShortcut(e, 'PageUp')) {
    return Math.max(0, (index < 0 ? count - 1 : index) - pageSize)
  }
  if (matchesShortcut(e, ['Ctrl+Home', 'Mod+Home']) || (ctx.inputEmpty && matchesShortcut(e, 'Home'))) {
    return 0
  }
  if (matchesShortcut(e, ['Ctrl+End', 'Mod+End']) || (ctx.inputEmpty && matchesShortcut(e, 'End'))) {
    return count - 1
  }
  return null
}

/**
 * Turns an arbitrary key (tag name, command id) into a string that is safe as
 * an HTML id fragment and as a CSS selector without escaping. Injective:
 * every char outside `[A-Za-z0-9-]` becomes `_<hex code point>_`.
 */
export function idFragment(key: string): string {
  let out = ''
  for (const ch of key) {
    out += /[A-Z0-9-]/i.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`
  }
  return out
}
