import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'

// Cross-cutting route attributes read back via `route.meta` — declared here,
// on the route table, so the classification has a single source of truth.
declare module 'vue-router' {
  interface RouteMeta {
    /**
     * Renders the filtered waterfall: filter/sort state is projected into the
     * URL query on these routes (see useSyncFilterWithUrl in shared/state.ts).
     */
    gallery?: boolean
    /**
     * Sidebar entry this page lives under when it has no entry of its own
     * (e.g. /unrated-artists is reached from the annotate page); SpecialPathList
     * lights that entry up.
     */
    navParent?: string
    /**
     * Which gallery list a `gallery` route shows. The one place a page asks
     * "am I /random?" — instead of matching `route.path` / `route.name` at every
     * call site (`/` has no name, so those checks kept disagreeing about it).
     * `/` is the same view as `/all`.
     */
    view?: 'all' | 'dir' | 'random' | 'recently' | 'unratedArtists'
    /**
     * `false` on pages with nothing to show in the right-hand detail pane
     * (Tags, Settings…): App.vue doesn't render the pane there, and its
     * toggle is hidden. Omitted = the pane is available.
     */
    rightPanel?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', component: () => import('./views/Home.vue'), meta: { gallery: true, view: 'all' } },
  { path: '/all', component: () => import('./views/Home.vue'), name: 'all', meta: { gallery: true, view: 'all' } },
  { path: '/dir/:folder*', component: () => import('./views/Home.vue'), name: 'dir', meta: { gallery: true, view: 'dir' } },
  { path: '/random', component: () => import('./views/Home.vue'), meta: { gallery: true, view: 'random' } },
  { path: '/recently', component: () => import('./views/Home.vue'), name: 'recently', meta: { gallery: true, view: 'recently' } },
  { path: '/unrated-artists', component: () => import('./views/Home.vue'), name: 'unratedArtists', meta: { gallery: true, view: 'unratedArtists', navParent: '/annotate' } },
  { path: '/tags', component: () => import('./views/Tags.vue'), name: 'tags', meta: { rightPanel: false } },
  // Component playground: dev server only, so the view never ships.
  ...(import.meta.env.DEV ? [{ path: '/test', component: () => import('./views/Test.vue'), name: 'test', meta: { rightPanel: false } }] : []),
  { path: '/post/:postId', component: () => import('./views/Post.vue'), name: 'post' },
  { path: '/annotate', component: () => import('./views/Annotate.vue'), name: 'annotate' },
  { path: '/settings', component: () => import('./views/Settings.vue'), name: 'settings', meta: { rightPanel: false } },
  { path: '/:pathMatch(.*)*', component: () => import('./views/NotFound.vue'), name: 'notFound', meta: { rightPanel: false } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
