import { describe, expect, it } from 'vitest'
import { clampToViewport, clipRectToViewport, groupMenuItems, isKeyboardContextMenu, nextInOrder } from '@/ui/overlay'

const VIEW = { width: 800, height: 600 }

describe('clamptoviewport', () => {
  it('leaves a box that fits alone', () => {
    expect(clampToViewport({ x: 100, y: 100 }, { width: 200, height: 100 }, VIEW, 4)).toEqual({ x: 100, y: 100 })
  })

  it('pulls a box back from the right and bottom edges (height, not width, for y)', () => {
    expect(clampToViewport({ x: 700, y: 550 }, { width: 200, height: 100 }, VIEW, 4)).toEqual({ x: 596, y: 496 })
  })

  it('pushes a box off the top-left margin', () => {
    expect(clampToViewport({ x: -20, y: 1 }, { width: 10, height: 10 }, VIEW, 4)).toEqual({ x: 4, y: 4 })
  })

  it('keeps the start of an oversized box visible', () => {
    expect(clampToViewport({ x: 50, y: 50 }, { width: 900, height: 700 }, VIEW, 4)).toEqual({ x: 4, y: 4 })
  })
})

describe('cliprecttoviewport', () => {
  it('returns a fully visible rect unchanged', () => {
    expect(clipRectToViewport({ x: 10, y: 20, width: 30, height: 40 }, VIEW)).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })

  it('clips a rect taller than the viewport', () => {
    expect(clipRectToViewport({ x: 10, y: -100, width: 30, height: 1000 }, VIEW)).toEqual({ x: 10, y: 0, width: 30, height: 600 })
  })

  it('collapses a rect fully below the viewport onto the bottom edge', () => {
    expect(clipRectToViewport({ x: 10, y: 700, width: 30, height: 40 }, VIEW)).toEqual({ x: 10, y: 600, width: 30, height: 0 })
  })
})

describe('iskeyboardcontextmenu', () => {
  it('trusts the last input modality', () => {
    expect(isKeyboardContextMenu({ clientX: 300, clientY: 200 }, true)).toBe(true)
    expect(isKeyboardContextMenu({ clientX: 300, clientY: 200 }, false)).toBe(false)
  })

  it('treats (0, 0) as keyboard-generated', () => {
    expect(isKeyboardContextMenu({ clientX: 0, clientY: 0 }, false)).toBe(true)
  })
})

describe('groupmenuitems', () => {
  it('keeps a label-free menu as one unlabelled run', () => {
    const data = [{ title: 'a' }, { title: 'b' }]
    expect(groupMenuItems(data)).toEqual([
      { kind: 'group', key: 0, label: null, items: [{ item: data[0], index: 0 }, { item: data[1], index: 1 }] },
    ])
  })

  it('groups items under each label until the next divider or label', () => {
    const data = [
      { title: 'loose' },
      { role: 'label' as const, title: 'Sort' },
      { title: 'name' },
      { title: 'date' },
      { role: 'divider' as const },
      { title: 'after' },
      { role: 'label' as const, title: 'Empty' },
      { role: 'label' as const, title: 'View' },
      { title: 'grid' },
    ]
    const sections = groupMenuItems(data)
    expect(sections.map(s => s.kind === 'divider' ? '—' : `${s.label?.title ?? '∅'}:${s.items.map(i => i.item.title).join(',')}`)).toEqual([
      '∅:loose',
      'Sort:name,date',
      '—',
      '∅:after',
      'Empty:',
      'View:grid',
    ])
    const sort = sections[1]
    expect(sort.kind === 'group' && sort.label?.index).toBe(1)
    expect(sort.kind === 'group' && sort.items.map(i => i.index)).toEqual([2, 3])
  })

  it('drops empty unlabelled runs between dividers', () => {
    const data = [{ role: 'divider' as const }, { role: 'divider' as const }]
    expect(groupMenuItems(data).map(s => s.kind)).toEqual(['divider', 'divider'])
  })
})

describe('nextinorder', () => {
  const order = ['a', 'trigger', 'c1', 'c2', 'd']

  it('returns the next element after the anchor', () => {
    expect(nextInOrder(order, 'a')).toBe('trigger')
  })

  it('skips excluded elements (the popover content)', () => {
    expect(nextInOrder(order, 'trigger', el => el.startsWith('c'))).toBe('d')
  })

  it('returns null at the end or for an unknown anchor', () => {
    expect(nextInOrder(order, 'd')).toBeNull()
    expect(nextInOrder(order, 'zzz')).toBeNull()
  })
})
