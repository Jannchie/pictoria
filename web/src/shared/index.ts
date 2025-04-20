import type { PostSimplePublic } from '@/api'
import { v2GetFolders, v2SearchPosts } from '@/api'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { useStorage } from '@vueuse/core'
import { converter, parse } from 'culori'
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
export type RightPanelDatum = PostSimplePublic | ImageDatum | InputDatum
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
export const postSortColor = useLocalStorage<string | undefined>('pictoria.posts.color', undefined)
const postSortColorDebounce = useDebounce(postSortColor, 1000)
export const postSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.posts.sortOrder', 'desc')

export const bottomBarInfo = ref<string>('')

const toLab = converter('lab')

export function useInfinityPostsQuery() {
  const limit = 1000
  const route = useRoute()
  const isRandomPage = computed(() => route.path === '/random')
  const order = computed<'asc' | 'desc' | 'random'>(() => {
    return isRandomPage.value ? 'random' : postSortOrder.value as 'asc' | 'desc'
  })
  const body = computed<PostFilter>(() => {
    if (postSortColorDebounce.value) {
      const color = parse(postSortColorDebounce.value)
      const lab = toLab(color)
      if (lab === undefined) {
        return { ...postFilter.value, order_by: postSort.value, order: order.value }
      }
      return { ...postFilter.value, lab: [lab.l, lab.a, lab.b] }
    }
    return { ...postFilter.value, order_by: postSort.value, order: order.value }
  })
  return useInfiniteQuery({
    queryKey: ['posts', body],
    queryFn: async ({ pageParam = 0 }) => {
      const resp = await v2SearchPosts({
        body: body.value,
        query: {
          offset: pageParam,
          limit,
        },
      })
      return resp.data
    },
    initialPageParam: 0,
    staleTime: 1000 * 60 * 60,
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
  return computed<Array<PostSimplePublic>>(() => {
    return postsQuery.data.value?.pages.flatMap(page => page).filter(post => post !== undefined) ?? []
  })
}

export const tagSelectorWindowRef = ref()
export function openTagSelectorWindow() {
  tagSelectorWindowRef.value?.toggle()
}

export const showPostDetail = ref<PostSimplePublic | null>(null)

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
      const resp = await v2GetFolders({ })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    staleTime: 1000 * 60 * 60,
  })
}
