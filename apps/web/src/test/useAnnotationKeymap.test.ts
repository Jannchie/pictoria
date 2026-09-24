// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { activeKeys, choiceBindings, isForeignComposite, KEY_ROWS, keyToChoice, moveItem, sortableIntent, sortableTarget } from '@/composables/useAnnotationKeymap'

const DIMS = ['color', 'finish', 'composition']

function key(k: string, mods: Partial<{ altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, isComposing: boolean }> = {}) {
  return { key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods }
}

describe('keytochoice', () => {
  it('maps row keys to (dimension, value) within scale', () => {
    expect(keyToChoice('1', DIMS, 2)).toEqual({ dimension: 'color', value: 1 })
    expect(keyToChoice('2', DIMS, 2)).toEqual({ dimension: 'color', value: 2 })
    expect(keyToChoice('q', DIMS, 2)).toEqual({ dimension: 'finish', value: 1 })
    expect(keyToChoice('a', DIMS, 3)).toEqual({ dimension: 'composition', value: 1 })
    expect(keyToChoice('d', DIMS, 3)).toEqual({ dimension: 'composition', value: 3 })
  })

  it('is case-insensitive (caps lock)', () => {
    expect(keyToChoice('Q', DIMS, 2)).toEqual({ dimension: 'finish', value: 1 })
  })

  it('rejects keys beyond scale', () => {
    expect(keyToChoice('3', DIMS, 2)).toBeNull() // scale=2 时第三档不存在
    expect(keyToChoice('5', DIMS, 3)).toBeNull()
  })

  it('rejects keys for rows beyond dimension count', () => {
    expect(keyToChoice('a', ['color'], 2)).toBeNull()
  })

  it('supports 5-scale single-dimension (legacy overall)', () => {
    expect(keyToChoice('5', ['overall'], 5)).toEqual({ dimension: 'overall', value: 5 })
  })

  it('exposes key rows for ui hints', () => {
    expect(KEY_ROWS[0][0]).toBe('1')
    expect(KEY_ROWS[1][0]).toBe('q')
  })
})

describe('activekeys', () => {
  it('returns the listened keys for dimensions x scale', () => {
    expect(activeKeys(DIMS, 2)).toEqual(['1', '2', 'q', 'w', 'a', 's'])
    expect(activeKeys(['overall'], 5)).toEqual(['1', '2', '3', '4', '5'])
  })
})

describe('choicebindings', () => {
  it('pairs every listened key with its dimension and value', () => {
    expect(choiceBindings(['color', 'finish'], 2)).toEqual([
      { key: '1', dimension: 'color', value: 1 },
      { key: '2', dimension: 'color', value: 2 },
      { key: 'q', dimension: 'finish', value: 1 },
      { key: 'w', dimension: 'finish', value: 2 },
    ])
  })

  it('binds bare keys only, so ctrl+z / ctrl+c are never a rating', () => {
    const keys = choiceBindings(['a', 'b', 'c', 'd'], 5).map(b => b.key)
    expect(keys).toContain('z')
    expect(keys.every(k => !k.includes('+'))).toBe(true)
  })
})

describe('moveitem', () => {
  it('moves an item and clamps the target', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4])
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3])
    expect(moveItem([1, 2, 3], 1, 99)).toEqual([1, 3, 2])
    expect(moveItem([1, 2, 3], 1, -5)).toEqual([2, 1, 3])
  })

  it('ignores an out-of-range source and never mutates the input', () => {
    const list = [1, 2, 3]
    expect(moveItem(list, 7, 0)).toEqual([1, 2, 3])
    moveItem(list, 0, 2)
    expect(list).toEqual([1, 2, 3])
  })
})

describe('sortableintent', () => {
  it('idle: space/enter grab, alt+arrows move directly, v views', () => {
    expect(sortableIntent(key(' '), false)).toBe('grab')
    expect(sortableIntent(key('Enter'), false)).toBe('grab')
    expect(sortableIntent(key('ArrowUp', { altKey: true }), false)).toBe('prev')
    expect(sortableIntent(key('ArrowDown', { altKey: true }), false)).toBe('next')
    expect(sortableIntent(key('v'), false)).toBe('view')
    expect(sortableIntent(key('V'), false)).toBe('view')
  })

  it('idle: plain arrows and escape are left to roving focus / the session', () => {
    expect(sortableIntent(key('ArrowLeft'), false)).toBeNull()
    expect(sortableIntent(key('ArrowDown'), false)).toBeNull()
    expect(sortableIntent(key('Escape'), false)).toBeNull()
    expect(sortableIntent(key('ArrowLeft', { altKey: true }), false)).toBeNull() // browser Back
  })

  it('grabbed: arrows move, home/end jump, space/enter drop, escape cancels', () => {
    expect(sortableIntent(key('ArrowLeft'), true)).toBe('prev')
    expect(sortableIntent(key('ArrowUp'), true)).toBe('prev')
    expect(sortableIntent(key('ArrowRight'), true)).toBe('next')
    expect(sortableIntent(key('ArrowDown', { altKey: true }), true)).toBe('next')
    expect(sortableIntent(key('Home'), true)).toBe('first')
    expect(sortableIntent(key('End'), true)).toBe('last')
    expect(sortableIntent(key(' '), true)).toBe('drop')
    expect(sortableIntent(key('Enter'), true)).toBe('drop')
    expect(sortableIntent(key('Escape'), true)).toBe('cancel')
    expect(sortableIntent(key('v'), true)).toBeNull()
  })

  it('never claims ctrl/meta/shift combos or composition', () => {
    expect(sortableIntent(key('Enter', { ctrlKey: true }), false)).toBeNull()
    expect(sortableIntent(key('Enter', { metaKey: true }), true)).toBeNull()
    expect(sortableIntent(key(' ', { shiftKey: true }), false)).toBeNull()
    expect(sortableIntent(key('Enter', { isComposing: true }), false)).toBeNull()
  })
})

describe('sortabletarget', () => {
  it('clamps at both ends', () => {
    expect(sortableTarget('prev', 0, 4)).toBe(0)
    expect(sortableTarget('prev', 2, 4)).toBe(1)
    expect(sortableTarget('next', 3, 4)).toBe(3)
    expect(sortableTarget('next', 1, 4)).toBe(2)
    expect(sortableTarget('first', 3, 4)).toBe(0)
    expect(sortableTarget('last', 0, 4)).toBe(3)
  })
})

describe('isforeigncomposite', () => {
  it('blocks composites outside the session root only', () => {
    document.body.innerHTML = `
      <div id="session"><div role="radiogroup"><button id="inside" role="radio"></button></div></div>
      <div role="tree"><div id="treeitem" role="treeitem" tabindex="0"></div></div>
      <button id="plain"></button>`
    const root = document.querySelector<HTMLElement>('#session')
    expect(isForeignComposite(document.querySelector('#inside'), root)).toBe(false)
    expect(isForeignComposite(document.querySelector('#treeitem'), root)).toBe(true)
    expect(isForeignComposite(document.querySelector('#plain'), root)).toBe(false)
    expect(isForeignComposite(document.body, root)).toBe(false)
    expect(isForeignComposite(null, root)).toBe(false)
  })
})
