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

export const postSort = useLocalStorage<'id' | 'score' | 'rating' | 'created_at' | 'file_name' | 'published_at' | 'waifu_score' | 'silva_score'>('pictoria.posts.sort', 'id')
export const postSortColor = useLocalStorage<string | undefined>('pictoria.posts.color', undefined)
export const postSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.posts.sortOrder', 'desc')

// Seed for the /random page's random ordering. SQLite's random() re-rolls per
// query, so offset pagination needs a fixed seed to page consistently; this is
// regenerated on each visit to /random (see useWatchRoute) for a fresh shuffle.
export const randomSeed = ref(1)

// Sync postFilter with URL query parameters
export function useSyncFilterWithUrl() {
  const route = useRoute()
  const router = useRouter()

  // Watch each field separately so unrelated changes (e.g. tags) don't pay
  // the cost of deep traversal + full URL rebuild. Each watcher uses a
  // primitive-comparable signature derived from the array/tuple value.
  watch(
    () => [
      postFilter.value.score.join(','),
      postFilter.value.rating.join(','),
      postFilter.value.extension.join(','),
      postFilter.value.waifu_score_range?.join(',') ?? '',
      postFilter.value.waifu_score_levels.join(','),
      postFilter.value.silva_score_levels.join(','),
      postSort.value,
      postSortOrder.value,
      postSortColor.value ?? '',
    ],
    () => {
      const f = postFilter.value
      const query = { ...route.query }
      if (f.score.length > 0) {
        query.score = f.score.join(',')
      }
      else {
        delete query.score
      }
      if (f.rating.length > 0) {
        query.rating = f.rating.join(',')
      }
      else {
        delete query.rating
      }
      if (f.extension.length > 0) {
        query.extension = f.extension.join(',')
      }
      else {
        delete query.extension
      }
      if (f.waifu_score_range) {
        query.waifu_score_range = f.waifu_score_range.join(',')
      }
      else {
        delete query.waifu_score_range
      }
      if (f.waifu_score_levels.length > 0) {
        query.waifu_score_levels = f.waifu_score_levels.join(',')
      }
      else {
        delete query.waifu_score_levels
      }
      if (f.silva_score_levels.length > 0) {
        query.silva_score_levels = f.silva_score_levels.join(',')
      }
      else {
        delete query.silva_score_levels
      }
      // Sort state: omit defaults (sort=id, order=desc) so URLs stay clean,
      // matching the filter fields above.
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
    // Only update if the component is watching (to avoid initial load overriding filter state)
    if (newQuery.score !== undefined) {
      postFilter.value.score = (newQuery.score as string).split(',').map(Number)
    }

    if (newQuery.rating !== undefined) {
      postFilter.value.rating = (newQuery.rating as string).split(',').map(Number)
    }

    if (newQuery.extension !== undefined) {
      postFilter.value.extension = (newQuery.extension as string).split(',')
    }

    if (newQuery.waifu_score_range !== undefined) {
      const range = (newQuery.waifu_score_range as string).split(',').map(Number) as [number, number]
      postFilter.value.waifu_score_range = range
    }

    if (newQuery.waifu_score_levels !== undefined) {
      postFilter.value.waifu_score_levels = (newQuery.waifu_score_levels as string).split(',')
    }

    if (newQuery.silva_score_levels !== undefined) {
      postFilter.value.silva_score_levels = (newQuery.silva_score_levels as string).split(',')
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
