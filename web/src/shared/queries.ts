import type { QueryClient } from '@tanstack/vue-query'
import type { PostSimplePublic } from '@/api'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useDebounce } from '@vueuse/core'
import { converter, parse } from 'culori'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { v2GetFolders, v2SearchPosts } from '@/api'
import { queryKeys } from './queryKeys'
import { postFilter, postSort, postSortColor, postSortOrder, randomSeed } from './state'

const postSortColorDebounce = useDebounce(postSortColor, 1000)
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

  const orderBy = computed<'id' | 'score' | 'rating' | 'created_at' | 'file_name' | 'published_at' | 'last_accessed_at' | 'waifu_score' | 'silva_score'>(() => {
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
      // Pin the random shuffle seed so every page of the infinite query shares
      // one ordering; it's part of the queryKey, so a new seed → a fresh query.
      ...(isRandomPage.value ? { order_seed: randomSeed.value, sort_direction: postSortOrder.value } : {}),
    }
    return labTuple.value ? { ...base, lab: labTuple.value } : base
  })

  return useInfiniteQuery({
    queryKey: queryKeys.posts(requestBody),
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
    queryKey: queryKeys.folders,
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
