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

/**
 * 一页多少条。**这是一个双向的权衡，不是纯粹的优化。**
 *
 * 换来的：筛选条件是 queryKey 的一部分，所以每一次筛选变化都会重取第一页。1000 条
 * 那会儿是几百 KB 到 1 MB 的 JSON，加上解析和 Vue 的响应式转换，还让所有下游 O(n)
 * 逻辑（每次 mutation 给已加载页打补丁、虚拟滚动的高度累加）都乘以 5。这条路径是
 * 交互式的，每次点筛选都走。
 *
 * 付出的：分页是 offset-based，而**没有可用索引的排序，每页成本与 limit 无关** ——
 * 整表 22.3 万行都要排一遍。在真实库上实测（深偏移，按 score 排序）：
 *
 *     limit=1000  231.7 ms/页        limit=200  243.4 ms/页
 *
 * 也就是说滚动同样的深度，服务端排序工作变成 5 倍（滚 5000 条：1.2 s → 6.1 s 的
 * 事件循环占用，better-sqlite3 是同步的）。受影响的是 score / rating / file_name /
 * created_at 和几个虚拟分数列；默认的 `id` 排序和 `/recently`（迁移 0015 的复合索引）
 * 都走索引，不受影响。
 *
 * 200 的取法：4K 屏铺满一屏约 60–80 张缩略图，留两屏多的预取余量；`getNextPageParam`
 * 按页长累加，改这个数不需要动滚动逻辑。
 *
 * 真正的解法是 keyset/cursor 分页 —— 让深翻页的成本不再随 offset 增长，那样两边就
 * 都不用让步了。在那之前这个数就是在"每次筛选的客户端成本"和"深翻页的服务端成本"
 * 之间选一头。
 */
const PAGE_SIZE = 200

export function useInfinityPostsQuery() {
  const limit = PAGE_SIZE
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

  const orderBy = computed<'id' | 'score' | 'rating' | 'created_at' | 'updated_at' | 'file_name' | 'published_at' | 'last_accessed_at' | 'waifu_score' | 'silva_score' | 'silva_luna_score' | 'discrepancy'>(() => {
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
      order: order.value,
      // On /random the default sort (id — PostSorter's "no specific sort")
      // must NOT be sent as order_by: the backend re-sorts the shuffled page
      // by any order_by it receives, so sending the default re-ordered every
      // random page back into id order and pure random browsing was
      // unreachable. Only forward an explicitly chosen sort.
      ...(isRandomPage.value && postSort.value === 'id'
        ? {}
        : { order_by: orderBy.value }),
      // Pin the random shuffle seed so every page of the infinite query shares
      // one ordering; it's part of the queryKey, so a new seed → a fresh query.
      ...(isRandomPage.value
        ? {
            order_seed: randomSeed.value,
            ...(postSort.value === 'id' ? {} : { sort_direction: postSortOrder.value }),
          }
        : {}),
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
      // Sum page lengths instead of flat().length: flattening allocates an
      // array of every loaded post reference per fetch just to read a count.
      return allPages.reduce((n, page) => n + (page?.length ?? 0), 0)
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
