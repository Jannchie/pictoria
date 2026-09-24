// @vitest-environment happy-dom
import type { KeyScope, KeyScopeInputs, ScoreScope } from '@/composables/useKeyScope'
import { describe, expect, it } from 'vitest'
import { resolveKeyScope, resolveScoreScope, scoreFromKeyEvent } from '@/composables/useKeyScope'

// All-false baseline = "gallery route, nothing blocking" → the plain grid scope.
const BASE: KeyScopeInputs = {
  usingInput: false,
  detailOverlayOpen: false,
  dialogOpen: false,
  treeFocused: false,
  isPostRoute: false,
}

function scope(overrides: Partial<KeyScopeInputs>): KeyScope {
  return resolveKeyScope({ ...BASE, ...overrides })
}

describe('resolvekeyscope', () => {
  // The table pins the precedence of the four guards folded into one scope,
  // matching the old canHandleGridKeys / canHandlePageKeys (notUsingInput &&
  // !showPostDetail && !isAnyDialogOpen && !focusedTreeFolder) plus the overlay.
  const cases: Array<[string, Partial<KeyScopeInputs>, KeyScope]> = [
    // Base routing: nothing blocking → grid on gallery, postPage on /post/:id.
    ['gallery, clear', {}, 'grid'],
    ['post route, clear', { isPostRoute: true }, 'postPage'],

    // Input focus wins over everything (incl. the overlay).
    ['input on gallery', { usingInput: true }, 'none'],
    ['input on post route', { usingInput: true, isPostRoute: true }, 'none'],
    ['input beats overlay', { usingInput: true, detailOverlayOpen: true }, 'none'],
    ['input beats all', {
      usingInput: true,
      detailOverlayOpen: true,
      dialogOpen: true,
      treeFocused: true,
      isPostRoute: true,
    }, 'none'],

    // Overlay takes over once open, regardless of dialog/tree/route (only input
    // can still preempt it) — mirrors PostDetail's notUsingInput-only guard.
    ['overlay on gallery', { detailOverlayOpen: true }, 'detailOverlay'],
    ['overlay on post route', { detailOverlayOpen: true, isPostRoute: true }, 'detailOverlay'],
    ['overlay beats dialog+tree', {
      detailOverlayOpen: true,
      dialogOpen: true,
      treeFocused: true,
    }, 'detailOverlay'],

    // Dialog / tree focus stand the grid & page hotkeys down (→ none).
    ['dialog on gallery', { dialogOpen: true }, 'none'],
    ['dialog on post route', { dialogOpen: true, isPostRoute: true }, 'none'],
    ['tree focus on gallery', { treeFocused: true }, 'none'],
    ['tree focus on post route', { treeFocused: true, isPostRoute: true }, 'none'],
    ['dialog + tree on post route', { dialogOpen: true, treeFocused: true, isPostRoute: true }, 'none'],
  ]

  it.each(cases)('%s → %s', (_name, overrides, expected) => {
    expect(scope(overrides)).toBe(expected)
  })

  it('assigns exactly one scope for every input combination', () => {
    const valid: KeyScope[] = ['grid', 'postPage', 'detailOverlay', 'none']
    for (const usingInput of [false, true]) {
      for (const detailOverlayOpen of [false, true]) {
        for (const dialogOpen of [false, true]) {
          for (const treeFocused of [false, true]) {
            for (const isPostRoute of [false, true]) {
              const result = resolveKeyScope({ usingInput, detailOverlayOpen, dialogOpen, treeFocused, isPostRoute })
              expect(valid).toContain(result)
            }
          }
        }
      }
    }
  })
})

describe('resolvescorescope', () => {
  // Scoring is intentionally coarser than navigation: only "not in an input"
  // plus which route decides it. Dialog / overlay / tree focus never block it,
  // so the input shape doesn't even carry them.
  const cases: Array<[string, { usingInput: boolean, isPostRoute: boolean }, ScoreScope]> = [
    ['gallery, not in input → grid', { usingInput: false, isPostRoute: false }, 'grid'],
    ['post route, not in input → postPage', { usingInput: false, isPostRoute: true }, 'postPage'],
    ['input on gallery → none', { usingInput: true, isPostRoute: false }, 'none'],
    ['input on post route → none', { usingInput: true, isPostRoute: true }, 'none'],
  ]

  it.each(cases)('%s', (_name, inputs, expected) => {
    expect(resolveScoreScope(inputs)).toBe(expected)
  })

  it('is mutually exclusive between grid and postpage', () => {
    // The same digit keypress can never resolve to both scopes at once — this is
    // what replaces PostDetailPanel's old route.name double-fire guard.
    const gallery = resolveScoreScope({ usingInput: false, isPostRoute: false })
    const post = resolveScoreScope({ usingInput: false, isPostRoute: true })
    expect(gallery).toBe('grid')
    expect(post).toBe('postPage')
    expect(gallery).not.toBe(post)
  })
})

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}
function focusable(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.querySelector('[data-t]') as HTMLElement
}

describe('scorefromkeyevent', () => {
  it('maps bare digits 1–5 to scores', () => {
    expect(scoreFromKeyEvent(press('1'))).toBe(1)
    expect(scoreFromKeyEvent(press('5'))).toBe(5)
    expect(scoreFromKeyEvent(press('0'))).toBeNull()
    expect(scoreFromKeyEvent(press('6'))).toBeNull()
  })

  it('ignores any modifier — ctrl/alt/meta+digit must not score', () => {
    expect(scoreFromKeyEvent(press('1', { ctrlKey: true }))).toBeNull()
    expect(scoreFromKeyEvent(press('1', { altKey: true }))).toBeNull()
    expect(scoreFromKeyEvent(press('1', { metaKey: true }))).toBeNull()
    expect(scoreFromKeyEvent(press('!', { shiftKey: true }))).toBeNull()
  })

  it('ignores handled, composing and auto-repeat events', () => {
    const handled = new KeyboardEvent('keydown', { key: '1', cancelable: true })
    handled.preventDefault()
    expect(scoreFromKeyEvent(handled)).toBeNull()
    expect(scoreFromKeyEvent(press('1', { isComposing: true }))).toBeNull()
    expect(scoreFromKeyEvent(press('1', { repeat: true }))).toBeNull()
  })

  it('stands down in text fields and value widgets, but not on buttons / thumbnails', () => {
    expect(scoreFromKeyEvent(press('3', {}, focusable('<input data-t>')))).toBeNull()
    expect(scoreFromKeyEvent(press('3', {}, focusable('<select data-t></select>')))).toBeNull()
    expect(scoreFromKeyEvent(press('3', {}, focusable('<div data-t contenteditable="true"></div>')))).toBeNull()
    expect(scoreFromKeyEvent(press('3', {}, focusable('<div data-t role="slider"></div>')))).toBeNull()
    expect(scoreFromKeyEvent(press('3', {}, focusable('<div role="radiogroup"><button data-t role="radio"></button></div>')))).toBeNull()
    expect(scoreFromKeyEvent(press('3', {}, focusable('<button data-t></button>')))).toBe(3)
    expect(scoreFromKeyEvent(press('3', {}, focusable('<div data-t role="gridcell" tabindex="0"></div>')))).toBe(3)
  })
})
