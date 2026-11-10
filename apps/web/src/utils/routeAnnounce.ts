// Route-change policy for the app shell (document.title, the "navigated to"
// announcement and focus management). Pure so the rules are unit-tested
// (src/test/routeAnnounce.test.ts); App.vue wires them into router.afterEach.
//
// Focus rule — after a navigation, focus moves to <main id="main-content"> only
// when ALL of these hold:
//   • it isn't the initial load (never steal focus on page open);
//   • the path changed (query-only changes are filter/sort edits);
//   • it isn't post → post (arrow-key browsing on the post page);
//   • it isn't gallery → gallery (folder / All / Recently / Random / Unrated artists switches from
//     the sidebar — the user is working the tree/nav and must stay there);
//   • at run time, focus is not already inside <main> (the new page placed it
//     itself, e.g. the grid restoring the last viewed thumbnail).
// The title is announced on every path change except post → post (the post
// page announces "n / total — file" itself) and the initial load.

import type { GalleryView } from '@/shared/galleryView'

export interface RouteLike {
  path: string
  name?: string | symbol | null
  params?: Record<string, string | string[] | undefined>
  query?: Record<string, unknown>
  meta?: { gallery?: boolean, view?: GalleryView }
}

export interface RouteTitle {
  /** Message key under `route.*`, or null when `text` is the literal title (a folder name). */
  key: string | null
  params?: Record<string, string | number>
  text?: string
}

function param(route: RouteLike, name: string): string {
  const v = route.params?.[name]
  return Array.isArray(v) ? v.join('/') : (v ?? '')
}

/**
 * Title key per gallery view. `all` is the home page (`/`); `/all` shows the
 * same view but is titled `route.all` on purpose — see [[routeTitle]]. A folder
 * (`dir`) is named after its folder; this is its fallback for the root.
 */
const VIEW_TITLE_KEYS = {
  all: 'route.home',
  dir: 'route.home',
  random: 'route.random',
  recently: 'route.recently',
  unratedArtists: 'route.unratedArtists',
} as const satisfies Record<GalleryView, string>

/** Title key per non-gallery route name (`post` is handled separately). */
const PAGE_TITLE_KEYS: Partial<Record<string, string>> = {
  tags: 'route.tags',
  test: 'route.test',
  annotate: 'route.annotate',
  settings: 'route.settings',
  notFound: 'route.notFound',
}

const ANNOTATE_MODE_TITLE_KEYS = {
  absolute: 'route.annotateAbsolute',
  pairwise: 'route.annotatePairwise',
  listwise: 'route.annotateListwise',
} as const

/** What the page is called: a `route.*` key, or a folder name. */
export function routeTitle(route: RouteLike, postName?: string | null): RouteTitle {
  const view = route.meta?.view
  if (view === 'dir') {
    const name = param(route, 'folder').split('/').findLast(Boolean)
    if (name) {
      return { key: null, text: name }
    }
  }
  if (view === 'all' && route.name === 'all') {
    return { key: 'route.all' }
  }
  if (view) {
    return { key: VIEW_TITLE_KEYS[view] }
  }
  if (route.name === 'post') {
    return postName
      ? { key: null, text: postName }
      : { key: 'route.post', params: { id: param(route, 'postId') } }
  }
  if (route.name === 'annotate') {
    // A running session lives in the query (see views/Annotate.vue): name the tab after it.
    const queue = route.query?.queue
    if (typeof queue === 'string' && queue) {
      return { key: 'route.annotateQueue', params: { id: queue } }
    }
    const mode = route.query?.mode
    if (mode === 'absolute' || mode === 'pairwise' || mode === 'listwise') {
      return { key: ANNOTATE_MODE_TITLE_KEYS[mode] }
    }
  }
  const key = typeof route.name === 'string' ? PAGE_TITLE_KEYS[route.name] : undefined
  return { key: key ?? 'route.home' }
}

const isPost = (r: RouteLike) => r.name === 'post'
const isGallery = (r: RouteLike) => r.meta?.gallery === true

/** Should this navigation announce the new page title? */
export function shouldAnnounceRoute(to: RouteLike, from: RouteLike, initial: boolean): boolean {
  return !initial && to.path !== from.path && !(isPost(to) && isPost(from))
}

/** Should this navigation move focus to <main>? (The run-time "focus already in main" check is the caller's.) */
export function shouldFocusMain(to: RouteLike, from: RouteLike, initial: boolean): boolean {
  if (initial || to.path === from.path) {
    return false
  }
  if (isPost(to) && isPost(from)) {
    return false
  }
  return !(isGallery(to) && isGallery(from))
}
