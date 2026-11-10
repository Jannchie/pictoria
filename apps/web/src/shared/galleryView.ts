import type { RouteMeta } from 'vue-router'
import type { PostOrderColumn } from './postFilter'

/** The gallery list a route shows — `meta.view` on the route table (main.ts). */
export type GalleryView = NonNullable<RouteMeta['view']>

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

const VIEW_SORT_OVERRIDES: Partial<Record<GalleryView, PostOrderColumn>> = {
  // Forced by the list request (`searchPostsBody`'s `recently` mode).
  recently: 'last_accessed_at',
  // A fixed server-side order with no sort column — `id` carries no badge.
  unratedArtists: 'id',
}

/**
 * The sort column a view imposes regardless of the user's `postSort`, or
 * undefined when the user's choice applies.
 */
export function viewSortOverride(view: GalleryView | undefined): PostOrderColumn | undefined {
  return view ? VIEW_SORT_OVERRIDES[view] : undefined
}
