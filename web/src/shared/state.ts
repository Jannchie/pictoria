import type { PostSimplePublic } from '@/api'
import { useLocalStorage, useStorage } from '@vueuse/core'
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

export const postSort = useLocalStorage<'id' | 'score' | 'rating' | 'created_at' | 'updated_at' | 'file_name' | 'published_at' | 'waifu_score' | 'silva_score'>('pictoria.posts.sort', 'id')
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

// Sync postFilter with URL query parameters
export function useSyncFilterWithUrl() {
  const route = useRoute()
  const router = useRouter()

  // Primitive-comparable signatures avoid deep traversal on every reactive flush.
  watch(
    () => [
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
    ],
    () => {
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

  // Watch for URL changes and update postFilter
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
}

export const waterfallRowCount = useStorage('pictoria.waterfallRowCount', 4)
export const selectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const selectingPostIdSet = ref<Set<number | undefined>>(new Set())
export const unselectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const currentPath = ref<string | symbol>('')
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
