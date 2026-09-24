import type { TreeListItemData } from '@/ui/treeListModel'
import { describe, expect, it } from 'vitest'
import { flattenTree, resolveTreeKey } from '@/ui/treeListModel'

// root
// a/            (open)
//   a/x
//   a/y/        (closed)
//     a/y/z
// b/            (closed)
//   b/q
// c
const ITEMS: TreeListItemData[] = [
  { title: 'Root', value: '@' },
  {
    title: 'Alpha',
    value: 'a',
    children: [
      { title: 'Xray', value: 'a/x' },
      { title: 'Yank', value: 'a/y', children: [{ title: 'Zulu', value: 'a/y/z' }] },
    ],
  },
  { title: 'Bravo', value: 'b', children: [{ title: 'Quebec', value: 'b/q' }] },
  { title: 'Charlie', value: 'c' },
]

function rowsFor(open: string[], items = ITEMS) {
  const set = new Set(open)
  return flattenTree(items, { isOpen: v => set.has(v) })
}
const values = (rows: ReturnType<typeof rowsFor>) => rows.map(r => r.value)
const at = (rows: ReturnType<typeof rowsFor>, v: string) => rows.findIndex(r => r.value === v)

describe('flattentree', () => {
  it('flattens only expanded branches, with aria level / setsize / posinset', () => {
    const rows = rowsFor(['a'])
    expect(values(rows)).toEqual(['@', 'a', 'a/x', 'a/y', 'b', 'c'])
    const y = rows[at(rows, 'a/y')]
    expect(y).toMatchObject({ level: 1, posinset: 2, setsize: 2, type: 'collapse', open: false, parents: ['a'] })
    expect(rows[at(rows, 'c')]).toMatchObject({ level: 0, posinset: 4, setsize: 4, type: 'link' })
  })

  it('counts only kept siblings when filtering and forces branches open', () => {
    const rows = flattenTree(ITEMS, {
      isOpen: () => false,
      forceOpen: true,
      keep: function keep(it): boolean {
        return it.title.toLowerCase().includes('z') || ('children' in it && (it.children ?? []).some(keep))
      },
    })
    expect(values(rows)).toEqual(['a', 'a/y', 'a/y/z'])
    expect(rows[0]).toMatchObject({ posinset: 1, setsize: 1, open: true, forcedOpen: true })
  })

  it('does not count headers as tree items', () => {
    const rows = flattenTree([{ title: 'Section' }, { title: 'One', value: '1' }, { title: 'Two', value: '2' }], { isOpen: () => false })
    expect(rows[0]).toMatchObject({ type: 'header', value: undefined, setsize: 0 })
    expect(rows[2]).toMatchObject({ posinset: 2, setsize: 2 })
  })
})

describe('resolvetreekey', () => {
  const rows = rowsFor(['a'])

  it('moves with arrows, home and end, skipping nothing visible', () => {
    expect(resolveTreeKey(rows, at(rows, 'a'), 'ArrowDown')).toEqual({ type: 'focus', value: 'a/x' })
    expect(resolveTreeKey(rows, at(rows, 'a/x'), 'ArrowUp')).toEqual({ type: 'focus', value: 'a' })
    expect(resolveTreeKey(rows, at(rows, 'b'), 'Home')).toEqual({ type: 'focus', value: '@' })
    expect(resolveTreeKey(rows, at(rows, 'a'), 'End')).toEqual({ type: 'focus', value: 'c' })
    expect(resolveTreeKey(rows, 0, 'ArrowUp')).toBeNull()
    expect(resolveTreeKey(rows, rows.length - 1, 'ArrowDown')).toBeNull()
  })

  it('pages by pagesize, clamped to the ends', () => {
    expect(resolveTreeKey(rows, 0, 'PageDown', 2)).toEqual({ type: 'focus', value: 'a/x' })
    expect(resolveTreeKey(rows, 0, 'PageDown', 50)).toEqual({ type: 'focus', value: 'c' })
    expect(resolveTreeKey(rows, at(rows, 'c'), 'PageUp', 50)).toEqual({ type: 'focus', value: '@' })
  })

  it('→ expands a closed branch, then enters it; does nothing on a leaf', () => {
    expect(resolveTreeKey(rows, at(rows, 'a/y'), 'ArrowRight')).toEqual({ type: 'expand', value: 'a/y' })
    expect(resolveTreeKey(rows, at(rows, 'a'), 'ArrowRight')).toEqual({ type: 'focus', value: 'a/x' })
    expect(resolveTreeKey(rows, at(rows, 'c'), 'ArrowRight')).toBeNull()
  })

  it('← collapses an open branch, else goes to the parent', () => {
    expect(resolveTreeKey(rows, at(rows, 'a'), 'ArrowLeft')).toEqual({ type: 'collapse', value: 'a' })
    expect(resolveTreeKey(rows, at(rows, 'a/y'), 'ArrowLeft')).toEqual({ type: 'focus', value: 'a' })
    expect(resolveTreeKey(rows, at(rows, 'c'), 'ArrowLeft')).toBeNull()
  })

  it('← on a filter-forced open branch goes to the parent instead of a no-op collapse', () => {
    const filtered = flattenTree(ITEMS, { isOpen: () => true, forceOpen: true })
    expect(resolveTreeKey(filtered, at(filtered, 'a/y'), 'ArrowLeft')).toEqual({ type: 'focus', value: 'a' })
  })

  it('* expands every closed sibling branch', () => {
    expect(resolveTreeKey(rows, at(rows, 'c'), '*')).toEqual({ type: 'expandMany', values: ['b'] })
    expect(resolveTreeKey(rows, at(rows, 'a/x'), '*')).toEqual({ type: 'expandMany', values: ['a/y'] })
    const allOpen = rowsFor(['a', 'b', 'a/y'])
    expect(resolveTreeKey(allOpen, 0, '*')).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(resolveTreeKey(rows, 0, 'Enter')).toBeNull()
    expect(resolveTreeKey(rows, 0, 'x')).toBeNull()
  })
})
