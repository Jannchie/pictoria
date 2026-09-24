import { describe, expect, it } from 'vitest'
import { idFragment, listboxKeyIndex } from '@/utils/listboxNav'

function key(k: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return { key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...init } as unknown as KeyboardEvent
}

describe('listboxkeyindex', () => {
  it('wraps with arrows and anchors from -1', () => {
    expect(listboxKeyIndex(key('ArrowDown'), { index: 0, count: 3 })).toBe(1)
    expect(listboxKeyIndex(key('ArrowDown'), { index: 2, count: 3 })).toBe(0)
    expect(listboxKeyIndex(key('ArrowUp'), { index: 0, count: 3 })).toBe(2)
    expect(listboxKeyIndex(key('ArrowDown'), { index: -1, count: 3 })).toBe(0)
    expect(listboxKeyIndex(key('ArrowUp'), { index: -1, count: 3 })).toBe(2)
  })

  it('clamps page moves', () => {
    expect(listboxKeyIndex(key('PageDown'), { index: 0, count: 25 })).toBe(10)
    expect(listboxKeyIndex(key('PageDown'), { index: 20, count: 25 })).toBe(24)
    expect(listboxKeyIndex(key('PageUp'), { index: 5, count: 25 })).toBe(0)
    expect(listboxKeyIndex(key('PageUp'), { index: 20, count: 25, pageSize: 5 })).toBe(15)
  })

  it('home/end only with an empty input, ctrl+home/end always', () => {
    expect(listboxKeyIndex(key('Home'), { index: 3, count: 5 })).toBeNull()
    expect(listboxKeyIndex(key('Home'), { index: 3, count: 5, inputEmpty: true })).toBe(0)
    expect(listboxKeyIndex(key('End'), { index: 0, count: 5, inputEmpty: true })).toBe(4)
    expect(listboxKeyIndex(key('Home', { ctrlKey: true }), { index: 3, count: 5 })).toBe(0)
    expect(listboxKeyIndex(key('End', { ctrlKey: true }), { index: 0, count: 5 })).toBe(4)
  })

  it('ignores other keys, modifiers, composition and empty lists', () => {
    expect(listboxKeyIndex(key('a'), { index: 0, count: 3 })).toBeNull()
    expect(listboxKeyIndex(key('ArrowDown', { shiftKey: true }), { index: 0, count: 3 })).toBeNull()
    expect(listboxKeyIndex(key('ArrowDown', { isComposing: true }), { index: 0, count: 3 })).toBeNull()
    expect(listboxKeyIndex(key('ArrowDown'), { index: 0, count: 0 })).toBeNull()
  })
})

describe('idfragment', () => {
  it('keeps safe chars and escapes the rest injectively', () => {
    expect(idFragment('nav-all')).toBe('nav-all')
    expect(idFragment('1girl')).toBe('1girl')
    expect(idFragment('green_eyes')).toBe('green_5f_eyes')
    expect(idFragment('a b')).not.toBe(idFragment('a_b'))
    expect(idFragment(':)')).toMatch(/^[\w-]+$/)
    expect(idFragment('猫')).toMatch(/^[\w-]+$/)
  })
})
