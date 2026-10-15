import type { DirectorySummary } from '@/api'
import { describe, expect, it } from 'vitest'
import { ancestorPaths, buildFolderTree, findFolderNode, folderTreeItemHeight, hasStatsLine, parentFolder, sortFolders } from '@/utils/folderTree'
import { splitHighlight } from '@/utils/highlight'

function dir(name: string, over: Partial<DirectorySummary> = {}): DirectorySummary {
  return {
    name,
    path: name,
    fileCount: 0,
    postCount: 0,
    silvaAvg: null,
    silvaLunaAvg: null,
    scoreAvg: null,
    ratingAvg: null,
    scoredRatio: null,
    children: [],
    ...over,
  }
}

describe('sortfolders', () => {
  const a = dir('a', { fileCount: 5, silvaAvg: 0.2 })
  const b = dir('B', { fileCount: 1, silvaAvg: null })
  const c = dir('c', { fileCount: 9, silvaAvg: 0.9 })

  it('sorts by name with localecompare, both directions', () => {
    expect(sortFolders([c, b, a], 'name', 'asc').map(d => d.name)).toEqual(['a', 'B', 'c'])
    expect(sortFolders([c, b, a], 'name', 'desc').map(d => d.name)).toEqual(['c', 'B', 'a'])
  })

  it('sorts numerically; a missing average counts as -1 (sinks in desc)', () => {
    expect(sortFolders([a, b, c], 'count', 'desc').map(d => d.name)).toEqual(['c', 'a', 'B'])
    expect(sortFolders([a, b, c], 'silva', 'desc').map(d => d.name)).toEqual(['c', 'a', 'B'])
    expect(sortFolders([a, b, c], 'silva', 'asc').map(d => d.name)).toEqual(['B', 'a', 'c'])
  })

  it('does not mutate its input', () => {
    const input = [c, a]
    sortFolders(input, 'name', 'asc')
    expect(input.map(d => d.name)).toEqual(['c', 'a'])
  })
})

describe('buildfoldertree', () => {
  const root = dir('', {
    fileCount: 3,
    postCount: 3,
    children: [
      dir('z', { path: 'z', fileCount: 1 }),
      dir('m', { path: 'm', children: [dir('y', { path: 'm/y' }), dir('b', { path: 'm/b' })] }),
    ],
  })

  it('is empty until the folders load', () => {
    expect(buildFolderTree(undefined, { key: 'name', order: 'asc', rootTitle: 'All' })).toEqual([])
  })

  it('puts a root row first, then every level sorted; folders with children collapse', () => {
    const tree = buildFolderTree(root, { key: 'name', order: 'asc', rootTitle: 'All' })
    expect(tree.map(i => i.title)).toEqual(['All', 'm', 'z'])
    expect(tree[0]).toMatchObject({ value: '@', count: 3, meta: { postCount: 3 } })
    const m = tree[1] as { children: { value: string }[] }
    expect(m.children.map(c => c.value)).toEqual(['m/b', 'm/y'])
    expect('children' in tree[2]!).toBe(false)
  })

  it('finds nodes at any depth', () => {
    const tree = buildFolderTree(root, { key: 'name', order: 'asc', rootTitle: 'All' })
    expect(findFolderNode(tree, 'm/y')?.title).toBe('y')
    expect(findFolderNode(tree, '@')?.title).toBe('All')
    expect(findFolderNode(tree, 'nope')).toBeNull()
  })
})

describe('row heights', () => {
  it('a stats line needs files or posts; headers are shortest', () => {
    expect(hasStatsLine({ title: 'x', value: 'x', count: 0, meta: { postCount: 0 } })).toBe(false)
    expect(hasStatsLine({ title: 'x', value: 'x', count: 2 })).toBe(true)
    expect(folderTreeItemHeight({ title: 'x', value: 'x', count: 2 })).toBe(48)
    expect(folderTreeItemHeight({ title: 'x', value: 'x' })).toBe(32)
    expect(folderTreeItemHeight({ title: 'header' })).toBe(28)
  })
})

describe('path helpers', () => {
  it('ancestorpaths lists every prefix, ignoring empty segments', () => {
    expect(ancestorPaths('a/b/c')).toEqual(['a', 'a/b', 'a/b/c'])
    expect(ancestorPaths('/a//b/')).toEqual(['a', 'a/b'])
    expect(ancestorPaths('')).toEqual([])
  })

  it('parentfolder falls back to the root', () => {
    expect(parentFolder('a/b/c')).toBe('a/b')
    expect(parentFolder('a')).toBe('@')
  })
})

describe('splithighlight', () => {
  it('splits around the first case-insensitive hit of the trimmed needle', () => {
    expect(splitHighlight('Pixiv Art pixiv', ' PIXIV ')).toEqual([
      { text: '', match: false },
      { text: 'Pixiv', match: true },
      { text: ' Art pixiv', match: false },
    ])
  })

  it('no needle or no hit → one unmatched part', () => {
    expect(splitHighlight('abc', '  ')).toEqual([{ text: 'abc', match: false }])
    expect(splitHighlight('abc', 'x')).toEqual([{ text: 'abc', match: false }])
  })
})
