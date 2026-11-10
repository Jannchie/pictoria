import type { RouteLike } from '@/utils/routeAnnounce'
import { describe, expect, it } from 'vitest'
import { routeTitle, shouldAnnounceRoute, shouldFocusMain } from '@/utils/routeAnnounce'

const home: RouteLike = { path: '/', meta: { view: 'all' } }
const dir = (folder: string): RouteLike => ({ path: `/dir/${folder}`, name: 'dir', params: { folder: folder.split('/') }, meta: { view: 'dir' } })
const post = (id: number): RouteLike => ({ path: `/post/${id}`, name: 'post', params: { postId: String(id) } })
const tags: RouteLike = { path: '/tags', name: 'tags' }

describe('routetitle', () => {
  it('uses route keys for fixed pages', () => {
    expect(routeTitle(home)).toEqual({ key: 'route.home' })
    expect(routeTitle(tags)).toEqual({ key: 'route.tags' })
    expect(routeTitle({ path: '/annotate', name: 'annotate', query: { mode: 'pairwise', strategy: 'close' } })).toEqual({ key: 'route.annotatePairwise' })
    expect(routeTitle({ path: '/annotate', name: 'annotate', query: { queue: '12' } })).toEqual({ key: 'route.annotateQueue', params: { id: '12' } })
    expect(routeTitle({ path: '/annotate', name: 'annotate', query: {} })).toEqual({ key: 'route.annotate' })
    expect(routeTitle({ path: '/all', name: 'all', meta: { view: 'all' } })).toEqual({ key: 'route.all' })
    expect(routeTitle({ path: '/random', meta: { view: 'random' } })).toEqual({ key: 'route.random' })
    expect(routeTitle({ path: '/recently', name: 'recently', meta: { view: 'recently' } })).toEqual({ key: 'route.recently' })
    expect(routeTitle({ path: '/nowhere', name: 'notFound' })).toEqual({ key: 'route.notFound' })
    expect(routeTitle({ path: '/unrated-artists', name: 'unratedArtists', meta: { view: 'unratedArtists' } })).toEqual({ key: 'route.unratedArtists' })
  })

  it('names a folder by its last segment', () => {
    expect(routeTitle(dir('art/2024/summer'))).toEqual({ key: null, text: 'summer' })
    expect(routeTitle({ path: '/dir', name: 'dir', params: { folder: [] }, meta: { view: 'dir' } })).toEqual({ key: 'route.home' })
  })

  it('names a post by file name when known, else by id', () => {
    expect(routeTitle(post(7), 'cat.png')).toEqual({ key: null, text: 'cat.png' })
    expect(routeTitle(post(7))).toEqual({ key: 'route.post', params: { id: '7' } })
  })
})

describe('route change policy', () => {
  it('never announces or moves focus on the initial load', () => {
    expect(shouldAnnounceRoute(tags, home, true)).toBe(false)
    expect(shouldFocusMain(tags, home, true)).toBe(false)
  })

  it('ignores query-only changes', () => {
    expect(shouldAnnounceRoute(home, home, false)).toBe(false)
    expect(shouldFocusMain(home, home, false)).toBe(false)
  })

  it('leaves post → post browsing alone', () => {
    expect(shouldAnnounceRoute(post(2), post(1), false)).toBe(false)
    expect(shouldFocusMain(post(2), post(1), false)).toBe(false)
  })

  it('announces but keeps focus for gallery → gallery (tree / nav switches)', () => {
    expect(shouldAnnounceRoute(dir('a'), home, false)).toBe(true)
    expect(shouldFocusMain(dir('a'), home, false)).toBe(false)
  })

  it('moves focus into main when crossing into another kind of page', () => {
    expect(shouldFocusMain(tags, home, false)).toBe(true)
    expect(shouldFocusMain(post(1), dir('a'), false)).toBe(true)
    expect(shouldFocusMain(home, post(1), false)).toBe(true)
  })
})
