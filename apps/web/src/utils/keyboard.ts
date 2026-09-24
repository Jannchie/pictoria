/**
 * Pure keyboard helpers: target classification (is focus in a text field / a
 * widget that owns its own keys?) and shortcut strings (`'Mod+Shift+K'`) —
 * parsing, exact matching and display.
 *
 * Everything here is side-effect free and safe to import in node (vitest):
 * element checks are duck-typed on `nodeType`, and `isMac` is `false` when
 * there is no `window`.
 *
 * Shortcut grammar: `+`-separated tokens, modifiers first, key last.
 * - Modifiers: `Mod` (⌘ on Mac, Ctrl elsewhere), `Ctrl`/`Control`, `Alt`/
 *   `Option`, `Shift`, `Meta`/`Cmd`/`Command`. Case-insensitive.
 * - Key: a `KeyboardEvent.key` value, compared case-insensitively (`K` ≡ `k`,
 *   `escape` ≡ `Escape`), or an alias: `Space`, `Esc`, `Up`/`Down`/`Left`/
 *   `Right`, `Plus` (or a trailing `++`), `Del`, `Return`, `PgUp`/`PgDn`.
 */

/** Detects an Apple platform from a Navigator-like object. Exported for tests. */
export function detectMac(nav: { platform?: string, userAgent?: string } | undefined): boolean {
  if (!nav) {
    return false
  }
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || '')
}

/**
 * True on macOS / iOS. Always `false` outside a browser (node's global
 * `navigator` would otherwise report the host OS during tests).
 */
export const isMac: boolean = globalThis.window !== undefined && detectMac(globalThis.navigator)

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

/** `<input type>`s that do NOT take text entry (they are widgets, not typing targets). */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'range',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'image',
  'hidden',
])

const TYPING_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton'])

/**
 * Roles / elements that own Arrow / Enter / Space themselves. A global hotkey
 * on those keys must stand down while one of them (or a descendant of one)
 * has focus, or it would steal the widget's keys.
 */
const WIDGET_ROLES = [
  'slider',
  'radio',
  'radiogroup',
  'option',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'tablist',
  'switch',
  'checkbox',
  'tree',
  'treeitem',
  'grid',
  'gridcell',
  'separator',
  'scrollbar',
]
const WIDGET_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  'input[type=checkbox]',
  'input[type=radio]',
  'input[type=range]',
  ...WIDGET_ROLES.map(r => `[role=${r}]`),
].join(',')

/** Value widgets where a bare digit / arrow means "change my value". */
const VALUE_WIDGET_SELECTOR = [
  'input[type=range]',
  'input[type=radio]',
  '[role=slider]',
  '[role=spinbutton]',
  '[role=radio]',
  '[role=radiogroup]',
].join(',')

function asElement(el: EventTarget | Element | null | undefined): Element | null {
  if (el && typeof el === 'object' && (el as Node).nodeType === 1) {
    return el as Element
  }
  return null
}

/**
 * True when `el` takes text entry: text-like `<input>`, `<textarea>`,
 * `<select>`, anything contenteditable, or role textbox / combobox /
 * searchbox / spinbutton. Only `el` itself is inspected (contenteditable is
 * inherited by descendants through `isContentEditable`).
 */
export function isTypingTarget(el: EventTarget | Element | null | undefined): boolean {
  const node = asElement(el)
  if (!node) {
    return false
  }
  const tag = node.tagName
  if (tag === 'INPUT') {
    const type = (node.getAttribute('type') ?? 'text').toLowerCase()
    return !NON_TEXT_INPUT_TYPES.has(type)
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') {
    return true
  }
  if ((node as HTMLElement).isContentEditable) {
    return true
  }
  const role = node.getAttribute('role')
  return role != null && TYPING_ROLES.has(role)
}

/** Walks from `node` up to (but excluding) `<body>`, testing `selector`. */
function selfOrAncestorMatches(node: Element, selector: string): boolean {
  const body = node.ownerDocument?.body
  for (let n: Element | null = node; n && n !== body; n = n.parentElement) {
    if (n.matches(selector)) {
      return true
    }
  }
  return false
}

/**
 * True when focus is in something that owns Arrow / Enter / Space itself:
 * a typing target, or an element (or ancestor below `<body>`) that is a
 * button, link, `<summary>`, checkbox / radio / range input, or carries a
 * widget role (slider, radio(group), option, listbox, menu*, tab(list),
 * switch, checkbox, tree(item), grid(cell), separator, scrollbar).
 */
export function isWidgetTarget(el: EventTarget | Element | null | undefined): boolean {
  const node = asElement(el)
  if (!node) {
    return false
  }
  return isTypingTarget(node) || selfOrAncestorMatches(node, WIDGET_SELECTOR)
}

/**
 * True when focus is in a *value* widget (slider, spinbutton, radio / radio
 * group, range input) — where a bare digit or arrow is expected to change
 * that widget's value, so e.g. digit scoring hotkeys must not fire.
 */
export function isValueWidgetTarget(el: EventTarget | Element | null | undefined): boolean {
  const node = asElement(el)
  if (!node) {
    return false
  }
  return selfOrAncestorMatches(node, VALUE_WIDGET_SELECTOR)
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/** A parsed shortcut with `Mod` already resolved to `ctrl` or `meta`. */
export interface ParsedShortcut {
  /** Lower-cased `KeyboardEvent.key` value (`'k'`, `'escape'`, `' '`, `'arrowup'`, `'+'`). */
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface ShortcutPlatformOptions {
  /** Treat as Mac (`Mod` = Meta, ⌘-style display). Defaults to {@link isMac}. */
  mac?: boolean
}

const KEY_ALIASES: Record<string, string> = {
  space: ' ',
  spacebar: ' ',
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  plus: '+',
  del: 'delete',
  return: 'enter',
  pgup: 'pageup',
  pgdn: 'pagedown',
}

/**
 * Parses `'Mod+Shift+K'` into modifier flags + a normalised key. Throws on an
 * unknown modifier or a missing key, so a typo fails loudly at registration.
 */
export function parseShortcut(shortcut: string, options: ShortcutPlatformOptions = {}): ParsedShortcut {
  const mac = options.mac ?? isMac
  // A literal space key (`' '`, `'Shift+ '`) would be trimmed away below.
  const source = shortcut === ' ' || shortcut.endsWith('+ ') ? `${shortcut.slice(0, -1)}Space` : shortcut
  let tokens = source.split('+').map(t => t.trim())
  // `Mod++` / a lone `+` → the key is '+' (split leaves empty tokens behind).
  let key: string | undefined
  if (tokens.length >= 2 && tokens.at(-1) === '' && tokens.at(-2) === '') {
    key = '+'
    tokens = tokens.slice(0, -2)
  }
  else {
    key = tokens.pop()
  }
  if (!key) {
    throw new Error(`Invalid shortcut "${shortcut}": missing key`)
  }
  const parsed: ParsedShortcut = { key: '', ctrl: false, alt: false, shift: false, meta: false }
  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case 'mod': {
        if (mac) {
          parsed.meta = true
        }
        else {
          parsed.ctrl = true
        }
        break
      }
      case 'ctrl':
      case 'control': {
        parsed.ctrl = true
        break
      }
      case 'alt':
      case 'option': {
        parsed.alt = true
        break
      }
      case 'shift': {
        parsed.shift = true
        break
      }
      case 'meta':
      case 'cmd':
      case 'command': {
        parsed.meta = true
        break
      }
      default: {
        throw new Error(`Invalid shortcut "${shortcut}": unknown modifier "${token}"`)
      }
    }
  }
  const lower = key.toLowerCase()
  parsed.key = KEY_ALIASES[lower] ?? lower
  return parsed
}

/** Single ASCII letter a–z. */
function isLetter(key: string): boolean {
  return key.length === 1 && key >= 'a' && key <= 'z'
}

/**
 * Keys whose `e.key` is itself (usually) a shifted symbol: single printable
 * characters that are not a letter, digit or space (`?`, `+`, `!`, `<`, …).
 * Whether Shift is needed to type them depends on the keyboard layout (`+`
 * is Shift+= on US, unshifted on the numpad / German layout), so for these
 * the Shift state is ignored unless the shortcut spells `Shift` explicitly.
 */
function isShiftAgnosticSymbol(key: string): boolean {
  return key.length === 1 && !isLetter(key) && !(key >= '0' && key <= '9') && key !== ' '
}

/**
 * Exact shortcut match against a keyboard event.
 *
 * - Ctrl / Alt / Meta must match exactly: `Z` does not match Ctrl+Z and
 *   `Ctrl+Z` does not match a bare Z.
 * - Shift must match exactly too, except for shift-agnostic symbols (see
 *   {@link isShiftAgnosticSymbol}): `'?'` matches Shift+/ on a US layout.
 *   Writing `'Shift+?'` makes Shift required again.
 * - Letters compare case-insensitively; when `e.key` is not an ASCII letter
 *   (non-Latin layout, or Option on Mac turning K into ˚) a letter shortcut
 *   falls back to `e.code` (`KeyK`).
 */
export function matchesShortcut(
  e: KeyboardEvent,
  shortcut: string | readonly string[],
  options: ShortcutPlatformOptions = {},
): boolean {
  const list = typeof shortcut === 'string' ? [shortcut] : shortcut
  return list.some(s => matchesParsed(e, parseShortcut(s, options)))
}

function matchesParsed(e: KeyboardEvent, p: ParsedShortcut): boolean {
  if (e.ctrlKey !== p.ctrl || e.altKey !== p.alt || e.metaKey !== p.meta) {
    return false
  }
  if (!(isShiftAgnosticSymbol(p.key) && !p.shift) && e.shiftKey !== p.shift) {
    return false
  }
  const eventKey = (e.key ?? '').toLowerCase()
  if (eventKey === p.key) {
    return true
  }
  if (isLetter(p.key) && !isLetter(eventKey) && typeof e.code === 'string') {
    return e.code === `Key${p.key.toUpperCase()}`
  }
  return false
}

const KEY_DISPLAY: Record<string, string> = {
  ' ': 'Space',
  'escape': 'Esc',
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'enter': 'Enter',
  'delete': 'Delete',
  'backspace': 'Backspace',
  'tab': 'Tab',
  'home': 'Home',
  'end': 'End',
  'pageup': 'PgUp',
  'pagedown': 'PgDn',
  'contextmenu': 'Menu',
}

function displayKey(key: string): string {
  if (KEY_DISPLAY[key]) {
    return KEY_DISPLAY[key]
  }
  if (key.length === 1) {
    return key.toUpperCase()
  }
  // 'f1' → 'F1', 'insert' → 'Insert'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * Key caps for `<kbd>` rendering, modifiers first.
 * Mac: `['⌃', '⌥', '⇧', '⌘', 'K']` (Apple order); elsewhere
 * `['Ctrl', 'Alt', 'Shift', 'Meta', 'K']`. Key names (`Space`, `Esc`,
 * `Enter`, …) are conventional key-cap labels and are not translated.
 */
export function shortcutKeys(shortcut: string, options: ShortcutPlatformOptions = {}): string[] {
  const mac = options.mac ?? isMac
  const p = parseShortcut(shortcut, { mac })
  const keys: string[] = []
  if (mac) {
    if (p.ctrl) {
      keys.push('⌃')
    }
    if (p.alt) {
      keys.push('⌥')
    }
    if (p.shift) {
      keys.push('⇧')
    }
    if (p.meta) {
      keys.push('⌘')
    }
  }
  else {
    if (p.ctrl) {
      keys.push('Ctrl')
    }
    if (p.alt) {
      keys.push('Alt')
    }
    if (p.shift) {
      keys.push('Shift')
    }
    if (p.meta) {
      keys.push('Meta')
    }
  }
  keys.push(displayKey(p.key))
  return keys
}

/** Display string: `'Ctrl+Shift+K'` elsewhere, `'⇧⌘K'` on Mac; arrows as ←↑→↓. */
export function formatShortcut(shortcut: string, options: ShortcutPlatformOptions = {}): string {
  const mac = options.mac ?? isMac
  return shortcutKeys(shortcut, { mac }).join(mac ? '' : '+')
}
