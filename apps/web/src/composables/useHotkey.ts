import type { MaybeRefOrGetter } from 'vue'
import { useEventListener } from '@vueuse/core'
import { toValue } from 'vue'
import { isTypingTarget, isWidgetTarget, matchesShortcut } from '@/utils/keyboard'

/**
 * The single way to bind a global keyboard shortcut.
 *
 * Every hotkey goes through {@link shouldHandleHotkey}, which applies the same
 * stand-down rules everywhere: already-handled events, IME composition, focus
 * in a text field, focus on a widget that owns its keys, a `when` guard, and
 * auto-repeat. Escape is special: it is owned by the layer stack
 * (`@/shared/layers`) while any layer is open, so a window Escape hotkey only
 * ever sees the key when nothing is layered on top.
 */
export interface HotkeyOptions {
  /** Extra guard, read at key time. `false` → ignore. Default: always on. */
  when?: MaybeRefOrGetter<boolean>
  /** Fire even when focus is in a text field / select / contenteditable. Default `false`. */
  allowInTyping?: boolean
  /**
   * Fire even when focus is on a widget that owns its keys (button, link,
   * slider, menuitem, gridcell, …). Default `false` — right for
   * Arrow / Enter / Space / Delete. Letter and `Mod+…` hotkeys that don't
   * conflict with any widget should pass `true`.
   */
  allowInWidgets?: boolean
  /** Call `e.preventDefault()` when the handler runs. Default `true`. */
  preventDefault?: boolean
  /** Fire on auto-repeat (`e.repeat`). Default `true`. */
  repeat?: boolean
  /** Custom veto, run last: return `true` to skip this event. */
  ignore?: (e: KeyboardEvent) => boolean
  /**
   * Where to listen: `'window'` (default, bubble phase) or an element (e.g.
   * a panel root) — then the hotkey only fires while focus is inside it.
   */
  target?: 'window' | MaybeRefOrGetter<HTMLElement | null | undefined>
}

type ShortcutInput = MaybeRefOrGetter<string | readonly string[]>

/**
 * Pure decision: would a hotkey with these options handle `e`? Exported so
 * callers with bespoke listeners (and tests) share the exact same rules.
 */
export function shouldHandleHotkey(
  e: KeyboardEvent,
  shortcut: string | readonly string[],
  options: Omit<HotkeyOptions, 'target'> = {},
): boolean {
  if (e.defaultPrevented) {
    return false
  }
  // IME composition: keydown during composition (or the 229 "process" key)
  // belongs to the IME, never to a shortcut.
  if (e.isComposing || e.keyCode === 229) {
    return false
  }
  if (!matchesShortcut(e, shortcut)) {
    return false
  }
  if (options.repeat === false && e.repeat) {
    return false
  }
  if (!options.allowInTyping && isTypingTarget(e.target)) {
    return false
  }
  // Widgets include typing targets, so check what's left after allowInTyping.
  if (!options.allowInWidgets && !isTypingTarget(e.target) && isWidgetTarget(e.target)) {
    return false
  }
  if (options.when !== undefined && !toValue(options.when)) {
    return false
  }
  if (options.ignore?.(e)) {
    return false
  }
  return true
}

/**
 * Non-composable form for existing listeners (`onKeyStroke`, `@keydown`):
 * runs `handler` (and preventDefault unless disabled) when
 * {@link shouldHandleHotkey} passes. Returns whether it handled the event.
 */
export function handleHotkey(
  e: KeyboardEvent,
  shortcut: string | readonly string[],
  handler: (e: KeyboardEvent) => void,
  options: Omit<HotkeyOptions, 'target'> = {},
): boolean {
  if (!shouldHandleHotkey(e, shortcut, options)) {
    return false
  }
  if (options.preventDefault !== false) {
    e.preventDefault()
  }
  handler(e)
  return true
}

/**
 * Registers a keydown hotkey for the lifetime of the current effect scope
 * (component setup / effectScope); it is removed automatically on dispose.
 * `shortcut` may be reactive. Returns a manual `stop()`.
 *
 * @example
 * useHotkey('Mod+K', () => openPalette(), { allowInWidgets: true })
 * useHotkey(['ArrowLeft', 'ArrowRight'], e => step(e.key === 'ArrowLeft' ? -1 : 1), { when: () => scope.value === 'postPage' })
 */
export function useHotkey(
  shortcut: ShortcutInput,
  handler: (e: KeyboardEvent) => void,
  options: HotkeyOptions = {},
): () => void {
  const { target = 'window', ...rest } = options
  const listener = (e: KeyboardEvent) => {
    handleHotkey(e, toValue(shortcut), handler, rest)
  }
  if (target === 'window') {
    return useEventListener('keydown', listener)
  }
  return useEventListener(target, 'keydown', listener)
}
