import type { QueryClient } from '@tanstack/vue-query'
import type { PostSimplePublic } from '@/api'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useDebounce, useLocalStorage, useStorage } from '@vueuse/core'
import { converter, parse } from 'culori'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { v2BulkUpdatePostRating, v2BulkUpdatePostScore, v2GetFolders, v2SearchPosts } from '@/api'

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
}
export type RightPanelDatum = PostSimplePublic | ImageDatum | InputDatum
export const postFilter = ref<PostFilter>({
  rating: [],
  score: [],
  tags: [],
  extension: [],
  waifu_score_levels: [],
})
export const textSearchQuery = ref('')

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

export const postSort = useLocalStorage<'id' | 'score' | 'rating' | 'created_at' | 'file_name' | 'published_at' | 'waifu_score' | 'siglip_score'>('pictoria.posts.sort', 'id')
export const postSortColor = useLocalStorage<string | undefined>('pictoria.posts.color', undefined)
const postSortColorDebounce = useDebounce(postSortColor, 1000)
export const postSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.posts.sortOrder', 'desc')

export const bottomBarInfo = ref<string>('')

const toLab = converter('lab')

export function useInfinityPostsQuery() {
  const limit = 1000
  const route = useRoute()

  const isRandomPage = computed(() => route.path === '/random')
  const isRecentlyPage = computed(() => route.path === '/recently')

  const order = computed<'asc' | 'desc' | 'random'>(() => {
    if (isRandomPage.value) {
      return 'random'
    }
    if (isRecentlyPage.value) {
      return 'desc'
    }
    return postSortOrder.value as 'asc' | 'desc'
  })

  const orderBy = computed<'id' | 'score' | 'rating' | 'created_at' | 'file_name' | 'published_at' | 'last_accessed_at' | 'waifu_score' | 'siglip_score'>(() => {
    if (isRecentlyPage.value) {
      return 'last_accessed_at'
    }
    return postSort.value
  })

  // Isolated computed so the lab conversion only runs when the picked
  // color actually changes — without this, every filter change re-runs the
  // culori parse/converter chain even when the color hasn't moved.
  const labTuple = computed<[number, number, number] | undefined>(() => {
    const raw = postSortColorDebounce.value
    if (!raw) {
      return
    }
    const color = parse(raw)
    const lab = toLab(color)
    if (
      lab
      && typeof lab.l === 'number'
      && typeof lab.a === 'number'
      && typeof lab.b === 'number'
    ) {
      return [lab.l, lab.a, lab.b]
    }
  })

  const requestBody = computed(() => {
    const base = {
      ...postFilter.value,
      order_by: orderBy.value,
      order: order.value,
    }
    return labTuple.value ? { ...base, lab: labTuple.value } : base
  })

  return useInfiniteQuery({
    queryKey: ['posts', requestBody],
    queryFn: async ({ pageParam = 0 }) => {
      const resp = await v2SearchPosts({
        body: requestBody.value,
        query: { offset: pageParam, limit },
      })
      return resp.data
    },
    enabled: computed(() =>
      route.name === 'all'
      || route.name === 'dir'
      || route.path === '/'
      || route.path === '/random'
      || route.path === '/recently',
    ),
    initialPageParam: 0,
    staleTime: 1000 * 60 * 60,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || lastPage.length < limit) {
        return
      }
      return allPages.flat().length
    },
  })
}

export function usePosts() {
  const postsQuery = useInfinityPostsQuery()
  return computed<Array<PostSimplePublic>>(() => {
    return postsQuery.data.value?.pages.flat().filter(post => post !== undefined) ?? []
  })
}

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

// Optimistically patch posts inside the infinite-list cache without touching
// stats/count caches. Keeps order stable when the user changes score/rating
// while sorted by that field — the new value shows up in place; rows only
// re-sort on the next fetch (manual refresh, sort change, etc.).
export function patchPostsInListCache(
  queryClient: QueryClient,
  ids: Iterable<number>,
  patch: Partial<PostSimplePublic>,
) {
  const idSet = new Set(ids)
  if (idSet.size === 0) {
    return
  }
  queryClient.setQueriesData<{ pages: (PostSimplePublic[] | undefined)[], pageParams: unknown[] }>(
    {
      predicate: (q) => {
        const k = q.queryKey
        return Array.isArray(k) && k[0] === 'posts' && typeof k[1] === 'object' && k[1] !== null
      },
    },
    (old) => {
      if (!old || !Array.isArray(old.pages)) {
        return old
      }
      return {
        ...old,
        pages: old.pages.map(page =>
          Array.isArray(page)
            ? page.map(p => (p && idSet.has(p.id) ? { ...p, ...patch } : p))
            : page,
        ),
      }
    },
  )
}

// Utility function to update scores for multiple posts
export async function updateScoreForSelectedPosts(score: number) {
  const selectedIds = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]

  if (selectedIds.length === 0) {
    return
  }

  // Use the bulk update endpoint instead of individual requests
  await v2BulkUpdatePostScore({
    query: { ids: selectedIds, score },
  })
}

// Utility function to update ratings for multiple posts
export async function updateRatingForSelectedPosts(rating: number) {
  const selectedIds = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]

  if (selectedIds.length === 0) {
    return
  }

  // Use the bulk update endpoint
  await v2BulkUpdatePostRating({
    query: { ids: selectedIds, rating },
  })
}

export function useCurrentFolder() {
  const route = useRoute()
  return computed(() => {
    if (!route.params.folder) {
      return '@'
    }
    if (typeof route.params.folder === 'string') {
      return route.params.folder
    }
    return route.params.folder.join('/')
  })
}

export function useFoldersQuery() {
  return useQuery({
    queryKey: ['folders'],
    queryFn: async () => {
      const resp = await v2GetFolders({})
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    staleTime: 1000 * 60 * 60,
  })
}
