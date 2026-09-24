// Route-change policy for the app shell (document.title, the "navigated to"
// announcement and focus management). Pure so the rules are unit-tested
// (src/test/routeAnnounce.test.ts); App.vue wires them into router.afterEach.
//
// Focus rule — after a navigation, focus moves to <main id="main-content"> only
// when ALL of these hold:
//   • it isn't the initial load (never steal focus on page open);
//   • the path changed (query-only changes are filter/sort edits);
//   • it isn't post → post (arrow-key browsing on the post page);
//   • it isn't gallery → gallery (folder / All / Recently / Random switches from
//     the sidebar — the user is working the tree/nav and must stay there);
//   • at run time, focus is not already inside <main> (the new page placed it
//     itself, e.g. the grid restoring the last viewed thumbnail).
// The title is announced on every path change except post → post (the post
// page announces "n / total — file" itself) and the initial load.

export interface RouteLike {
  path: string
  name?: string | symbol | null
  params?: Record<string, string | string[] | undefined>
  meta?: { gallery?: boolean }
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

/** What the page is called: a `route.*` key, or a folder name. */
export function routeTitle(route: RouteLike, postName?: string | null): RouteTitle {
  switch (route.name) {
    case 'all': { return { key: 'route.all' }
    }
    case 'dir': {
      const folder = param(route, 'folder')
      const name = folder.split('/').findLast(Boolean)
      return name ? { key: null, text: name } : { key: 'route.home' }
    }
    case 'recently': { return { key: 'route.recently' }
    }
    case 'tags': { return { key: 'route.tags' }
    }
    case 'test': { return { key: 'route.test' }
    }
    case 'annotate': { return { key: 'route.annotate' }
    }
    case 'settings': { return { key: 'route.settings' }
    }
    case 'post': {
      return postName
        ? { key: null, text: postName }
        : { key: 'route.post', params: { id: param(route, 'postId') } }
    }
    default: {
      break
    }
  }
  if (route.path === '/random') {
    return { key: 'route.random' }
  }
  return { key: 'route.home' }
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
