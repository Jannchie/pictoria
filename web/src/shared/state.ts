import type { PostSimplePublic } from '@/api'
import { useActiveElement, useLocalStorage, useStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export const baseURL = 'http://localhost:4777'

interface ImageDatum {
  src: string
}
interface InputDatum {
  label: string
  value: string
}
interface PostFilter {
  rating: number[]
  score: number[]
  tags: string[]
  extension: string[]
  folder?: string
  waifu_score_range?: [number, number]
  waifu_score_levels: string[]
  silva_score_levels: string[]
}
export type RightPanelDatum = PostSimplePublic | ImageDatum | InputDatum
export const postFilter = ref<PostFilter>({
  rating: [],
  score: [],
  tags: [],
  extension: [],
  waifu_score_levels: [],
  silva_score_levels: [],
})
export const textSearchQuery = ref('')

export const postSort = useLocalStorage<'id' | 'score' | 'rating' | 'created_at' | 'updated_at' | 'file_name' | 'published_at' | 'waifu_score' | 'silva_score' | 'discrepancy'>('pictoria.posts.sort', 'id')
export const postSortColor = useLocalStorage<string | undefined>('pictoria.posts.color', undefined)
export const postSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.posts.sortOrder', 'desc')

// Seed for the /random page's random ordering. SQLite's random() re-rolls per
// query, so offset pagination needs a fixed seed to page consistently; this is
// regenerated on each visit to /random (see useWatchRoute) for a fresh shuffle.
export const randomSeed = ref(1)

// Declarative filter-to-URL mapping for array-typed PostFilter fields.
// Add a new entry here to sync a new array filter — no other changes needed.
// `encode`: percent-encode each value before the comma-join (and decode on the
// way back), so values that may contain commas/other reserved chars (tag names)
// round-trip safely. Omit it for value sets that never collide (numbers, exts).
const ARRAY_FILTERS: { key: keyof PostFilter & string, numeric?: boolean, encode?: boolean }[] = [
  { key: 'score', numeric: true },
  { key: 'rating', numeric: true },
  { key: 'extension' },
  { key: 'tags', encode: true },
  { key: 'waifu_score_levels' },
  { key: 'silva_score_levels' },
]

// Sync postFilter with URL query parameters. Must be mounted on a component
// that survives route changes (App.vue) — the URL→filter watcher below has to
// observe every navigation, and the filter→URL one re-projects after each
// path change.
export function useSyncFilterWithUrl() {
  const route = useRoute()
  const router = useRouter()

  // URL → filter. Registered FIRST: both watchers can fire in the same flush
  // (a navigation changes path and query together), and within one flush
  // callbacks run in registration order — the URL must be read into the
  // filter state before the projection below writes filter state back out,
  // or a fresh page load's query would be overwritten from the still-empty
  // filters. Keys absent from the URL leave the filter untouched (state is
  // the source of truth across navigations).
  watch(() => route.query, (newQuery) => {
    for (const { key, numeric, encode } of ARRAY_FILTERS) {
      if (newQuery[key] !== undefined) {
        const parts = (newQuery[key] as string).split(',')
        const decoded = encode ? parts.map(p => decodeURIComponent(p)) : parts
        ;(postFilter.value[key] as any) = numeric ? decoded.map(Number) : decoded
      }
    }

    if (newQuery.waifu_score_range !== undefined) {
      const range = (newQuery.waifu_score_range as string).split(',').map(Number) as [number, number]
      postFilter.value.waifu_score_range = range
    }

    if (newQuery.sort !== undefined) {
      postSort.value = newQuery.sort as typeof postSort.value
    }

    if (newQuery.order !== undefined) {
      postSortOrder.value = newQuery.order as typeof postSortOrder.value
    }

    if (newQuery.sort_color !== undefined) {
      postSortColor.value = newQuery.sort_color as string
    }
  }, { immediate: true })

  // Filter → URL.
  // Primitive-comparable signatures avoid deep traversal on every reactive flush.
  watch(
    () => {
      // Only gallery routes carry filters in their URL (meta.gallery, declared
      // on the route table in main.ts). Elsewhere collapse the signature so
      // the encode work below is skipped while e.g. /post/:id is open.
      if (!route.meta.gallery) {
        return false as const
      }
      return [
        // Re-project after navigation too: filter state is the source of truth,
        // so a link that dropped the query (or routed through a query-less page
        // like /post/:id) gets the filters written back onto the new URL —
        // they kept applying in memory either way; this keeps the URL honest
        // so reload/share doesn't silently lose them.
        route.path,
        // Encode the same way the URL write does, so a value containing ',' can't
        // make two distinct selections collapse to one signature (and skip a sync).
        ...ARRAY_FILTERS.map(({ key, encode }) => {
          const arr = postFilter.value[key] as unknown[]
          return encode ? arr.map(v => encodeURIComponent(String(v))).join(',') : arr.join(',')
        }),
        postFilter.value.waifu_score_range?.join(',') ?? '',
        postSort.value,
        postSortOrder.value,
        postSortColor.value ?? '',
      ]
    },
    (signature) => {
      if (signature === false) {
        return
      }
      const f = postFilter.value
      const query = { ...route.query }

      for (const { key, encode } of ARRAY_FILTERS) {
        const arr = f[key] as unknown[]
        if (arr.length > 0) {
          query[key] = encode ? arr.map(v => encodeURIComponent(String(v))).join(',') : arr.join(',')
        }
        else {
          delete query[key]
        }
      }

      if (f.waifu_score_range) {
        query.waifu_score_range = f.waifu_score_range.join(',')
      }
      else {
        delete query.waifu_score_range
      }

      // Sort state: omit defaults (sort=id, order=desc) so URLs stay clean.
      if (postSort.value === 'id') {
        delete query.sort
      }
      else {
        query.sort = postSort.value
      }
      if (postSortOrder.value === 'desc') {
        delete query.order
      }
      else {
        query.order = postSortOrder.value
      }
      if (postSortColor.value) {
        query.sort_color = postSortColor.value
      }
      else {
        delete query.sort_color
      }
      router.replace({ query })
    },
  )
}

export const waterfallRowCount = useStorage('pictoria.waterfallRowCount', 4)
export const selectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const selectingPostIdSet = ref<Set<number | undefined>>(new Set())
export const unselectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const hideNSFW = useStorage('pictoria.hideNSFW', false)
// When off, image placeholders fall back to a plain opacity fade-in instead
// of the per-shape arthash dissolve. Useful on low-end GPUs or when the
// animation feels distracting.
export const enableFancyPlaceholder = useStorage('pictoria.enableFancyPlaceholder', true)
// Master switch for the arthash placeholder. When off, the placeholder shows
// the dominant color only and the image fades in on load. Pair with the
// backend's DISABLE_ARTHASH env var if you also want to skip computing arthash
// for newly imported images.
export const enableArthash = useStorage('pictoria.enableArthash', true)

export const bottomBarInfo = ref<string>('')

export const tagSelectorWindowRef = ref()
export function openTagSelectorWindow() {
  tagSelectorWindowRef.value?.toggle()
}

export const showPostDetail = ref<PostSimplePublic | null>(null)

// Count of mounted <Dialog> modals — Dialog.vue increments/decrements on
// mount/unmount. Pages gate their global onKeyStroke hotkeys on this
// (see canHandle*Keys): Dialog's own Enter/Escape handlers can't swallow
// other window-level listeners, so the standing-down has to happen at each
// listener's guard, and a shared count beats every caller hand-tracking its
// own "is my dialog open" flag.
export const openDialogCount = ref(0)
export const isAnyDialogOpen = computed(() => openDialogCount.value > 0)

// Path of the folder-tree row that currently has keyboard focus (the tree's
// RouterLinks carry data-tree-value; clicking one focuses it). While a tree
// row is focused, the tree owns the keyboard — gallery/page hotkeys
// (canHandle*Keys) stand down, so e.g. Delete targets the focused folder
// instead of whatever posts are still selected in the gallery.
const activeElement = useActiveElement()
export const focusedTreeFolder = computed(() =>
  activeElement.value?.dataset.treeValue ?? null,
)

// Ordered list of posts currently visible/in-context. Producers (MainSection,
// Post page) write to this so keyboard navigation can move prev/next.
export const currentPostList = ref<PostSimplePublic[]>([])

// Similar-posts grid shown on the post detail page (/post/:id). Post.vue
// publishes it so the multi-select sidebar panel can resolve thumbnails/stats
// for selected similar posts — currentPostList stays the gallery list, which
// the detail page's prev/next arrow navigation still walks. Cleared on leave.
export const similarPostList = ref<PostSimplePublic[]>([])

// Per-route scrollTop cache for the gallery's MainSection. Survives Home.vue
// unmount when navigating to /post/:id so Esc/back restores the same position.
// Keyed by route.fullPath so different folders/filters keep separate state.
export const galleryScrollPositions = new Map<string, number>()

export const menuData = ref<any | null>(null)
export const showMenu = computed({ get: () => !!menuData.value, set: (value) => {
  if (!value) {
    menuData.value = null
  }
} })
