// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { handleHotkey, shouldHandleHotkey, useHotkey } from '@/composables/useHotkey'
import {
  detectMac,
  formatShortcut,
  isTypingTarget,
  isValueWidgetTarget,
  isWidgetTarget,
  matchesShortcut,
  parseShortcut,
  shortcutKeys,
} from '@/utils/keyboard'

function byId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!
}

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
}

function el(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.querySelector('[data-t]') as HTMLElement
}

/** Dispatches on `target` so `e.target` is set like a real keypress. */
function fire(target: EventTarget, e: KeyboardEvent): KeyboardEvent {
  target.dispatchEvent(e)
  return e
}

describe('detectmac', () => {
  it('recognises apple platforms only', () => {
    expect(detectMac({ platform: 'MacIntel' })).toBe(true)
    expect(detectMac({ platform: '', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe(true)
    expect(detectMac({ platform: 'Win32' })).toBe(false)
    expect(detectMac(undefined)).toBe(false)
  })
})

describe('parseshortcut', () => {
  it('resolves mod per platform', () => {
    expect(parseShortcut('Mod+K', { mac: false })).toEqual({ key: 'k', ctrl: true, alt: false, shift: false, meta: false })
    expect(parseShortcut('Mod+K', { mac: true })).toEqual({ key: 'k', ctrl: false, alt: false, shift: false, meta: true })
  })

  it('normalises modifiers and aliases', () => {
    expect(parseShortcut('ctrl+alt+shift+Esc')).toMatchObject({ key: 'escape', ctrl: true, alt: true, shift: true })
    expect(parseShortcut('Cmd+Up').meta).toBe(true)
    // a literal space is the Space key, not an empty shortcut
    expect(parseShortcut(' ')).toMatchObject({ key: ' ', shift: false })
    expect(parseShortcut('Shift+ ')).toMatchObject({ key: ' ', shift: true })
    expect(parseShortcut('Space').key).toBe(' ')
    expect(parseShortcut('Plus').key).toBe('+')
    expect(parseShortcut('Ctrl++')).toMatchObject({ key: '+', ctrl: true })
    expect(parseShortcut('+').key).toBe('+')
    expect(parseShortcut('Left').key).toBe('arrowleft')
  })

  it('throws on typos', () => {
    expect(() => parseShortcut('Ctlr+K')).toThrow(/unknown modifier/)
    expect(() => parseShortcut('Ctrl+')).toThrow()
  })
})

describe('matchesshortcut', () => {
  const pc = { mac: false }
  const mac = { mac: true }

  it('matches modifiers exactly', () => {
    expect(matchesShortcut(key('z', { ctrlKey: true }), 'Ctrl+Z', pc)).toBe(true)
    expect(matchesShortcut(key('z', { ctrlKey: true }), 'Z', pc)).toBe(false)
    expect(matchesShortcut(key('z'), 'Ctrl+Z', pc)).toBe(false)
    expect(matchesShortcut(key('Z', { ctrlKey: true, shiftKey: true }), 'Ctrl+Z', pc)).toBe(false)
    expect(matchesShortcut(key('Z', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z', pc)).toBe(true)
    expect(matchesShortcut(key('1', { altKey: true }), '1', pc)).toBe(false)
  })

  it('maps mod to meta on mac and ctrl elsewhere', () => {
    expect(matchesShortcut(key('k', { metaKey: true }), 'Mod+K', mac)).toBe(true)
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'Mod+K', mac)).toBe(false)
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'Mod+K', pc)).toBe(true)
  })

  it('compares letters case-insensitively and named keys by alias', () => {
    expect(matchesShortcut(key('K'), 'k', pc)).toBe(true) // Caps Lock: 'K' without Shift
    expect(matchesShortcut(key('K', { shiftKey: true }), 'k', pc)).toBe(false)
    expect(matchesShortcut(key('K', { shiftKey: true }), 'Shift+k', pc)).toBe(true)
    expect(matchesShortcut(key('Escape'), 'Esc', pc)).toBe(true)
    expect(matchesShortcut(key('ArrowUp'), 'Up', pc)).toBe(true)
    expect(matchesShortcut(key(' '), 'Space', pc)).toBe(true)
  })

  it('ignores shift for shifted symbols unless spelled out', () => {
    expect(matchesShortcut(key('?', { shiftKey: true }), '?', pc)).toBe(true)
    expect(matchesShortcut(key('+', { shiftKey: true }), 'Plus', pc)).toBe(true)
    expect(matchesShortcut(key('+'), '+', pc)).toBe(true)
    expect(matchesShortcut(key('?'), 'Shift+?', pc)).toBe(false)
    // '/' opens the palette: unshifted on US, Shift+7 on German layouts.
    expect(matchesShortcut(key('/'), '/', pc)).toBe(true)
    expect(matchesShortcut(key('/', { shiftKey: true }), '/', pc)).toBe(true)
    expect(matchesShortcut(key('/', { ctrlKey: true }), '/', pc)).toBe(false)
    // …but digits keep strict shift.
    expect(matchesShortcut(key('1', { shiftKey: true }), '1', pc)).toBe(false)
  })

  it('falls back to e.code for letters on non-latin layouts / option', () => {
    expect(matchesShortcut(key('к', { ctrlKey: true, code: 'KeyR' }), 'Ctrl+R', pc)).toBe(true)
    expect(matchesShortcut(key('˚', { altKey: true, code: 'KeyK' }), 'Alt+K', mac)).toBe(true)
    expect(matchesShortcut(key('j', { code: 'KeyK' }), 'K', pc)).toBe(false)
  })

  it('accepts a list', () => {
    expect(matchesShortcut(key('ArrowLeft'), ['ArrowRight', 'ArrowLeft'], pc)).toBe(true)
  })
})

describe('formatshortcut', () => {
  it('formats for pc and mac', () => {
    expect(formatShortcut('Mod+Shift+K', { mac: false })).toBe('Ctrl+Shift+K')
    expect(formatShortcut('Mod+Shift+K', { mac: true })).toBe('⇧⌘K')
    expect(formatShortcut('Alt+Left', { mac: false })).toBe('Alt+←')
    expect(formatShortcut('Esc', { mac: false })).toBe('Esc')
    expect(shortcutKeys('Ctrl+Alt+Shift+Mod+Space', { mac: true })).toEqual(['⌃', '⌥', '⇧', '⌘', 'Space'])
    expect(shortcutKeys('Mod+Enter', { mac: false })).toEqual(['Ctrl', 'Enter'])
  })
})

describe('target classification', () => {
  it.each([
    ['<input data-t>', true],
    ['<input data-t type="search">', true],
    ['<input data-t type="checkbox">', false],
    ['<input data-t type="range">', false],
    ['<textarea data-t></textarea>', true],
    ['<select data-t><option>a</option></select>', true],
    ['<div data-t contenteditable="true"></div>', true],
    ['<div data-t role="combobox"></div>', true],
    ['<div data-t role="spinbutton"></div>', true],
    ['<button data-t></button>', false],
    ['<div data-t></div>', false],
  ])('istypingtarget(%s) = %s', (html, expected) => {
    expect(isTypingTarget(el(html))).toBe(expected)
  })

  it('handles null and non-elements', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(globalThis)).toBe(false)
    expect(isWidgetTarget(document)).toBe(false)
  })

  it.each([
    ['<button data-t></button>', true],
    ['<a data-t href="#">x</a>', true],
    ['<a data-t>x</a>', false],
    ['<input data-t type="checkbox">', true],
    ['<input data-t>', true], // typing targets are widgets too
    ['<div role="slider"><span data-t></span></div>', true], // ancestor counts
    ['<div role="gridcell" data-t></div>', true],
    ['<div data-t tabindex="0"></div>', false],
  ])('iswidgettarget(%s) = %s', (html, expected) => {
    expect(isWidgetTarget(el(html))).toBe(expected)
  })

  it('does not treat body as a widget ancestor', () => {
    document.body.setAttribute('role', 'grid')
    try {
      expect(isWidgetTarget(el('<div data-t></div>'))).toBe(false)
    }
    finally {
      document.body.removeAttribute('role')
    }
  })

  it('isvaluewidgettarget only for value widgets', () => {
    expect(isValueWidgetTarget(el('<div role="slider" data-t></div>'))).toBe(true)
    expect(isValueWidgetTarget(el('<div role="radiogroup"><div data-t role="radio"></div></div>'))).toBe(true)
    expect(isValueWidgetTarget(el('<button data-t></button>'))).toBe(false)
    expect(isValueWidgetTarget(el('<div role="gridcell" data-t></div>'))).toBe(false)
  })
})

describe('shouldhandlehotkey', () => {
  it('skips handled, composing and repeat events', () => {
    const prevented = key('a')
    prevented.preventDefault()
    expect(shouldHandleHotkey(prevented, 'a')).toBe(false)
    expect(shouldHandleHotkey(key('a', { isComposing: true }), 'a')).toBe(false)
    expect(shouldHandleHotkey(key('a', { keyCode: 229 } as KeyboardEventInit), 'a')).toBe(false)
    expect(shouldHandleHotkey(key('a', { repeat: true }), 'a')).toBe(true)
    expect(shouldHandleHotkey(key('a', { repeat: true }), 'a', { repeat: false })).toBe(false)
  })

  it('stands down in typing targets and widgets unless allowed', () => {
    const input = el('<input data-t>')
    expect(shouldHandleHotkey(fire(input, key('a')), 'a')).toBe(false)
    expect(shouldHandleHotkey(fire(input, key('a')), 'a', { allowInTyping: true })).toBe(true)
    const button = el('<button data-t></button>')
    expect(shouldHandleHotkey(fire(button, key('Enter')), 'Enter')).toBe(false)
    expect(shouldHandleHotkey(fire(button, key('Enter')), 'Enter', { allowInWidgets: true })).toBe(true)
    // allowInWidgets alone does not open up text fields.
    expect(shouldHandleHotkey(fire(el('<input data-t>'), key('a')), 'a', { allowInWidgets: true })).toBe(false)
  })

  it('honours when and ignore', () => {
    expect(shouldHandleHotkey(key('a'), 'a', { when: false })).toBe(false)
    expect(shouldHandleHotkey(key('a'), 'a', { when: () => true })).toBe(true)
    expect(shouldHandleHotkey(key('a'), 'a', { ignore: () => true })).toBe(false)
  })
})

describe('handlehotkey / usehotkey', () => {
  it('prevents default only when handled', () => {
    const handler = vi.fn()
    const e = key('x')
    expect(handleHotkey(e, 'x', handler)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    const e2 = key('y')
    expect(handleHotkey(e2, 'x', handler)).toBe(false)
    expect(e2.defaultPrevented).toBe(false)
    const e3 = key('x')
    handleHotkey(e3, 'x', handler, { preventDefault: false })
    expect(e3.defaultPrevented).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('listens on window and is removed on scope dispose', () => {
    const handler = vi.fn()
    const scope = effectScope()
    scope.run(() => useHotkey('Shift+?', handler))
    globalThis.dispatchEvent(key('?', { shiftKey: true }))
    expect(handler).toHaveBeenCalledTimes(1)
    scope.stop()
    globalThis.dispatchEvent(key('?', { shiftKey: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('can listen on an element target only', () => {
    document.body.innerHTML = '<div id="panel"><span id="inner" tabindex="0"></span></div><span id="out"></span>'
    const panel = byId('panel')
    const handler = vi.fn()
    const scope = effectScope()
    scope.run(() => useHotkey('g', handler, { target: panel }))
    byId('inner').dispatchEvent(key('g'))
    byId('out').dispatchEvent(key('g'))
    expect(handler).toHaveBeenCalledTimes(1)
    scope.stop()
  })
})
