import type { PostPublic } from '@/api'
import { v1GetFolders, v1GetTagGroups, v1ListPosts } from '@/api'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

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
}
export type RightPanelDatum = PostPublic | ImageDatum | InputDatum
export const postFilter = ref<PostFilter>({
  rating: [],
  score: [],
  tags: [],
  extension: [],
})
export const waterfallRowCount = useStorage('pictoria.waterfallRowCount', 4)
export const selectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const selectingPostIdSet = ref<Set<number | undefined>>(new Set())
export const unselectedPostIdSet = ref<Set<number | undefined>>(new Set())
export const currentPath = ref<string | symbol>('')
export const hideNSFW = useStorage('pictoria.hideNSFW', false)

export const postSort = useLocalStorage<'id' | 'score' | 'rating' | 'created_at' | 'file_name' | 'published_at'>('pictoria.posts.sort', 'id')
export const postSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.posts.sortOrder', 'desc')

export function useInfinityPostsQuery() {
  const limit = 1000
  return useInfiniteQuery({
    queryKey: ['posts', postFilter, postSort, postSortOrder],
    queryFn: async ({ pageParam = 0 }) => {
      const resp = await v1ListPosts({
        body: { ...postFilter.value, order_by: postSort.value, order: postSortOrder.value },
        query: {
          offset: pageParam,
          limit,
        },
      })
      return resp.data
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage && lastPage.length < limit) {
        return undefined
      }
      const allPosts = allPages.flatMap(page => page)
      return allPosts.length
    },
  })
}

export function usePosts() {
  const postsQuery = useInfinityPostsQuery()
  // watchEffect(() => {
  //   if (postsQuery.hasNextPage.value && !postsQuery.isFetchingNextPage.value) {
  //     postsQuery.fetchNextPage()
  //   }
  // })
  return computed<Array<PostPublic>>(() => {
    return postsQuery.data.value?.pages.flatMap(page => page).filter(post => post !== undefined) ?? []
  })
}

export function useTagGroup() {
  const tagGroupResp = useQuery({
    queryKey: ['tag-groups'],
    queryFn: async () => {
      const resp = await v1GetTagGroups({ })
      return resp.data
    },
    staleTime: Infinity,
  })
  return computed(() => tagGroupResp.data.value ?? [])
}

export const tagSelectorWindowRef = ref()
export function openTagSelectorWindow() {
  tagSelectorWindowRef.value?.toggle()
}

export const showPostDetail = ref<PostPublic | null>(null)

export const menuData = ref<any | null>(null)
export const showMenu = computed({ get: () => !!menuData.value, set: (val) => {
  if (!val) {
    menuData.value = null
  }
} })

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
      const resp = await v1GetFolders({ })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    staleTime: 1000 * 60 * 60,
  })
}
