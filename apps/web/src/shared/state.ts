import type { PostFilterState, PostSortColumn, PostSortOrder } from './postFilter'
import type { PostSimplePublic } from '@/api'
import { useActiveElement, useLocalStorage, useStorage } from '@vueuse/core'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isGalleryRoute } from './galleryView'
import { emptyFacets, filterFromQuery, filterQuerySignature, filterToQuery, isPostSortColumn } from './postFilter'

export const baseURL = 'http://localhost:4777'

/** 画廊筛选状态。字段与编解码见 `./postFilter` 的字段表。 */
export const postFilter = ref<PostFilterState>(emptyFacets())
export const textSearchQuery = ref('')

export const postSort = useLocalStorage<PostSortColumn>('pictoria.posts.sort', 'id')
// The stored value outlives the sort columns: one that has since been removed
// would be sent as `orderBy` and fail every list request. Fall back to the default.
if (!isPostSortColumn(postSort.value)) {
  postSort.value = 'id'
}
export const postSortColor = useLocalStorage<string | undefined>('pictoria.posts.color', undefined)
export const postSortOrder = useLocalStorage<PostSortOrder>('pictoria.posts.sortOrder', 'desc')

// Seed for the /random page's random ordering. SQLite's random() re-rolls per
// query, so offset pagination needs a fixed seed to page consistently; this is
// regenerated on each visit to /random (see useWatchRoute) for a fresh shuffle.
export const randomSeed = ref(1)

function urlState() {
  return { filter: postFilter.value, sort: postSort.value, order: postSortOrder.value, sortColor: postSortColor.value }
}

// Sync postFilter with URL query parameters. Must be mounted on a component
// that survives route changes (App.vue) — the URL→filter watcher below has to
// observe every navigation, and the filter→URL one re-projects after each
// path change. The encoding itself lives in `./postFilter`.
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
    const patch = filterFromQuery(newQuery)
    for (const [key, value] of Object.entries(patch.filter)) {
      ;(postFilter.value as unknown as Record<string, unknown>)[key] = value
    }
    if (patch.sort !== undefined) {
      postSort.value = patch.sort
    }
    if (patch.order !== undefined) {
      postSortOrder.value = patch.order
    }
    if (patch.sortColor !== undefined) {
      postSortColor.value = patch.sortColor
    }
  }, { immediate: true })

  // Filter → URL.
  // Primitive-comparable signatures avoid deep traversal on every reactive flush.
  watch(
    () => {
      // Only gallery routes carry filters in their URL (isGalleryRoute, derived
      // from the route table's meta.view). Elsewhere collapse the signature so
      // the encode work below is skipped while e.g. /post/:id is open.
      if (!isGalleryRoute(route)) {
        return false as const
      }
      return [
        // Re-project after navigation too: filter state is the source of truth,
        // so a link that dropped the query (or routed through a query-less page
        // like /post/:id) gets the filters written back onto the new URL —
        // they kept applying in memory either way; this keeps the URL honest
        // so reload/share doesn't silently lose them.
        route.path,
        ...filterQuerySignature(urlState()),
      ]
    },
    (signature) => {
      if (signature === false) {
        return
      }
      router.replace({ query: filterToQuery(urlState(), route.query) })
    },
  )
}

export const waterfallRowCount = useStorage('pictoria.waterfallRowCount', 4)
export const hideNSFW = useStorage('pictoria.hideNSFW', false)

// Side-pane visibility lives in ./paneLayout (preference + auto-collapse).
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
/**
 * The gallery list's first page failed to load (MainSection publishes it), so
 * the footer can say so instead of reporting "0 shown" as if the view were
 * simply empty.
 */
export const galleryListFailed = ref(false)

export const tagSelectorWindowRef = ref()
/** 编辑器打开后要把光标放到的标签；TagSelector 消费后清空。 */
export const tagSelectorFocusTag = ref<string | null>(null)
/**
 * 不带参数：开关编辑器（"添加标签"按钮）。带标签名：打开（已开着就保持开着）并把
 * 光标定位到这个标签上 —— 从某个标签点进来的编辑，应该从它开始。
 */
export function openTagSelectorWindow(focusTag?: string) {
  if (focusTag === undefined) {
    tagSelectorWindowRef.value?.toggle()
    return
  }
  tagSelectorFocusTag.value = focusTag
  tagSelectorWindowRef.value?.open()
}

export const showPostDetail = ref<PostSimplePublic | null>(null)

/**
 * Id of the post the user was last looking at, for restoring the gallery
 * place on the way back. Set by the post page / detail overlay when leaving a
 * post; read by the gallery grid on mount to restore selection + keyboard
 * focus on that thumbnail (then it may be cleared). `null` = nothing to restore.
 */
export const lastViewedPostId = ref<number | null>(null)

// `isAnyDialogOpen` lives in the design system (ui/) so it doesn't depend on
// the app store; re-exported here so `@/shared` stays the single import.
export { isAnyDialogOpen } from '@/ui/modal'

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
export const currentPostList = shallowRef<PostSimplePublic[]>([])

// Similar-posts grid shown on the post detail page (/post/:id). Post.vue
// publishes it so the multi-select sidebar panel can resolve thumbnails/stats
// for selected similar posts — currentPostList stays the gallery list, which
// the detail page's prev/next arrow navigation still walks. Cleared on leave.
export const similarPostList = shallowRef<PostSimplePublic[]>([])

/**
 * Where ←→ on the post page walks when the post is not in the gallery list:
 * the similar-posts grid it was opened from (that grid's origin post first, so
 * ← leads back to it). Set by Post.vue when a similar post is opened, kept while
 * the walk stays inside the list, cleared when the page is left.
 */
export const postNavContext = shallowRef<{ kind: 'similar', list: PostSimplePublic[] } | null>(null)

// Per-route scrollTop cache for the gallery's MainSection. Survives Home.vue
// unmount when navigating to /post/:id so Esc/back restores the same position.
// Keyed by route.fullPath so different folders/filters keep separate state.
export const galleryScrollPositions = new Map<string, number>()
