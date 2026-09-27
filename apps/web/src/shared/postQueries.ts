/**
 * 单帖子详情这一族查询（详情、相似图、近重复组、组证据、标注历史）的
 * queryOptions 工厂。
 *
 * 每个 useXQuery 和 [[usePostPrefetch]] 的预取都从这里展开同一份
 * key + queryFn + staleTime —— 预取能被复用的前提是三者和 useQuery 完全一致，
 * 分两处手写的话哪天漂了，预取就会静默写进一个没人读的缓存。
 *
 * id 接受 ref：组件里传响应式 id，key 跟着变；预取传普通数字。
 */

import type { MaybeRef } from 'vue'
import { queryOptions } from '@tanstack/vue-query'
import { isAxiosError } from 'axios'
import { unref } from 'vue'
import { v2GetPost, v2GetPostGroup, v2GetPostGroupEvidence, v2GetSimilarPosts, v2PostHistory } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

/**
 * 这族查询的新鲜期。默认的 0 会让预取的数据在翻到那张时又被当作过期重拉
 * 一遍 —— 画面是瞬间出来了，请求却一个没省。30 秒足够覆盖「←→ 来回翻」；
 * 本地编辑走 mutation 的 setQueryData / invalidate，不受它影响。
 */
const POST_QUERY_STALE_TIME = 30_000

type PostIdRef = MaybeRef<number | undefined>

export function isValidPostId(id: number | undefined): id is number {
  return id !== undefined && Number.isFinite(id)
}

/** 取出 id；只在 `enabled`（isValidPostId）放行后才会被 queryFn 调到。 */
function postIdOf(id: PostIdRef) {
  return unref(id) as number
}

export function postQueryOptions(id: PostIdRef) {
  return queryOptions({
    // Locale lives in the key (folded into queryKeys.post) so a language
    // switch refetches the server-side translated tag names.
    // invalidateQueries(queryKeys.postRoot(id)) still matches by prefix.
    queryKey: queryKeys.post(id),
    queryFn: async () => {
      try {
        const resp = await v2GetPost({ path: { post_id: postIdOf(id) }, query: { lang: resolvedLocale.value } })
        return resp.data ?? null
      }
      catch (error) {
        // A deleted / unknown post is an answer, not a failure (the client
        // throws on every non-2xx): resolve to null at once instead of
        // retrying for ~7 s while the post page sits blank.
        if (isAxiosError(error) && error.response?.status === 404) {
          return null
        }
        throw error
      }
    },
    staleTime: POST_QUERY_STALE_TIME,
  })
}

export function similarPostsQueryOptions(id: MaybeRef<number>) {
  return queryOptions({
    queryKey: queryKeys.similarPosts(id),
    queryFn: async () => {
      const resp = await v2GetSimilarPosts({ path: { post_id: unref(id) } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    staleTime: POST_QUERY_STALE_TIME,
  })
}

// Near-duplicate group members of a canonical post — the hidden lower-resolution
// copies / differentials that the listings collapse behind it. Returns [] for a
// post that heads no group.
export function postGroupQueryOptions(id: PostIdRef) {
  return queryOptions({
    queryKey: queryKeys.postGroup(id),
    queryFn: async () => {
      const resp = await v2GetPostGroup({ path: { post_id: postIdOf(id) } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data ?? []
    },
    staleTime: POST_QUERY_STALE_TIME,
  })
}

export function postGroupEvidenceQueryOptions(id: PostIdRef) {
  return queryOptions({
    queryKey: queryKeys.postGroupEvidence(id),
    queryFn: async () => {
      const resp = await v2GetPostGroupEvidence({ path: { post_id: postIdOf(id) } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data ?? []
    },
    staleTime: POST_QUERY_STALE_TIME,
  })
}

export function postAnnotationsQueryOptions(id: MaybeRef<number>) {
  return queryOptions({
    // Reactive ref in the key (via the factory) so navigating between posts
    // refetches this post's history instead of reusing the first-loaded one.
    queryKey: queryKeys.annotations(id),
    queryFn: async () => {
      const resp = await v2PostHistory({ path: { post_id: unref(id) } })
      return resp.data
    },
    staleTime: POST_QUERY_STALE_TIME,
  })
}
