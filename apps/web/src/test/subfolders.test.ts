import type { FolderNodeLike } from '@/utils/subfolders'
import { describe, expect, it } from 'vitest'
import { childrenOf, filterSubfolders, previewSubfolders } from '@/utils/subfolders'

function node(path: string, fileCount: number, children: FolderNodeLike[] = []): FolderNodeLike {
  return { name: path.split('/').pop()!, path, fileCount, children }
}

const tree = node('.', 0, [
  node('danbooru', 100, [node('danbooru/long_artist', 5), node('danbooru/abc', 50, [node('danbooru/abc/deep', 1)])]),
  node('kemono', 10),
])

describe('childrenof', () => {
  it('returns root children for @', () => {
    expect(childrenOf(tree, '@').map(c => c.path)).toEqual(['danbooru', 'kemono'])
  })
  it('walks nested paths', () => {
    expect(childrenOf(tree, 'danbooru').map(c => c.path)).toEqual(['danbooru/long_artist', 'danbooru/abc'])
    expect(childrenOf(tree, 'danbooru/abc').map(c => c.path)).toEqual(['danbooru/abc/deep'])
  })
  it('returns [] for unknown paths and missing trees', () => {
    expect(childrenOf(tree, 'nope/x')).toEqual([])
    expect(childrenOf(null, '@')).toEqual([])
  })
})

const many = Array.from({ length: 1000 }, (_, i) => node(`d/a${i}`, (i * 7919) % 1000))

describe('previewsubfolders', () => {
  it('keeps natural order when short', () => {
    const kids = childrenOf(tree, 'danbooru')
    expect(previewSubfolders(kids, 24).map(c => c.path)).toEqual(['danbooru/long_artist', 'danbooru/abc'])
  })
  it('shows the biggest when long, matching a full sort', () => {
    const expected = [...many].sort((a, b) => b.fileCount - a.fileCount).slice(0, 24).map(c => c.fileCount)
    expect(previewSubfolders(many, 24).map(c => c.fileCount)).toEqual(expected)
  })
})

describe('filtersubfolders', () => {
  const kids = [node('x/long_hair_artist', 3), node('x/hairdo', 1), node('x/ahair', 9), node('x/other', 100)]
  it('puts prefix matches first, then by count; _ matches space', () => {
    expect(filterSubfolders(kids, 'hair').items.map(c => c.name)).toEqual(['hairdo', 'ahair', 'long_hair_artist'])
    expect(filterSubfolders(kids, 'long hair').items.map(c => c.name)).toEqual(['long_hair_artist'])
  })
  it('caps results and reports the total', () => {
    const r = filterSubfolders(many, 'a', 200)
    expect(r.items).toHaveLength(200)
    expect(r.total).toBe(1000)
  })
  it('empty filter lists biggest first', () => {
    expect(filterSubfolders(kids, '  ').items[0].name).toBe('other')
  })
})
