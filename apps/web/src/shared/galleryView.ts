import type { RouteMeta } from 'vue-router'
import type { PostOrderColumn } from './postFilter'

/** The gallery list a route shows — `meta.view` on the route table (router.ts). */
export type GalleryView = NonNullable<RouteMeta['view']>

/**
 * Whether a route renders the filtered waterfall (`/`, `/all`, `/dir/…`,
 * `/random`, `/recently`, `/unrated-artists`): exactly the routes that declare
 * a `meta.view`. Filter / sort state is projected into the URL query on these
 * (useSyncFilterWithUrl in shared/state.ts), and the gallery list query only
 * runs on them.
 */
export function isGalleryRoute(route: { meta?: Pick<RouteMeta, 'view'> }): boolean {
  return route.meta?.view !== undefined
}

const VIEW_NAME_KEYS = {
  all: 'nav.all',
  dir: 'nav.all',
  random: 'nav.random',
  recently: 'nav.recently',
  unratedArtists: 'nav.unratedArtists',
} as const satisfies Record<GalleryView, string>

/**
 * The filtered library views — the root (`/` is `/all`) or a folder. /random
 * and /recently resolve to the root folder too, but they reorder the library
 * rather than being a place in it; /unrated-artists ignores the filter.
 */
export function isLibraryView(view: GalleryView | undefined): boolean {
  return view === 'all' || view === 'dir'
}

/**
 * Message key of a view's sidebar label. A folder view is named after its
 * folder by the caller; this is its fallback (the root folder is "all").
 */
export function galleryViewNameKey(view: GalleryView | undefined): string {
  return VIEW_NAME_KEYS[view ?? 'all']
}

const VIEW_SORT_OVERRIDES: Partial<Record<GalleryView, { column: PostOrderColumn, labelKey: string }>> = {
  // Forced by the list request (`searchPostsBody`'s `recently` mode).
  recently: { column: 'last_accessed_at', labelKey: 'sort.lastAccessed' },
  // A fixed server-side order with no sort column — `id` carries no badge.
  unratedArtists: { column: 'id', labelKey: 'sort.fixedOrder' },
}

/**
 * The sort column the grid is actually in: the one a view imposes, else the
 * user's `postSort`. What the tile badges format their `sortValue` by.
 */
export function effectiveSort(view: GalleryView | undefined, userSort: PostOrderColumn): PostOrderColumn {
  return (view && VIEW_SORT_OVERRIDES[view]?.column) || userSort
}

/** Why the sort controls don't apply right now: the order in force, and the reason. */
export interface SortLock {
  labelKey: string
  reasonKey: string
}

/**
 * The lock on the user's sort, or undefined when it applies: a text search
 * orders by relevance, /recently and /unrated-artists by their own order. The
 * sort picker shows it as its disabled state; the command palette then offers
 * no sort commands.
 */
export function sortLock(view: GalleryView | undefined, textSearchActive: boolean): SortLock | undefined {
  if (textSearchActive) {
    return { labelKey: 'sort.relevance', reasonKey: 'sort.searchOverride' }
  }
  const forced = view ? VIEW_SORT_OVERRIDES[view] : undefined
  return forced ? { labelKey: forced.labelKey, reasonKey: 'sort.viewOverride' } : undefined
}
