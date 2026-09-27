import type { MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, toRef } from 'vue'
import { isValidPostId, similarPostsQueryOptions } from '@/shared/postQueries'

// 相似图查询。Post.vue（驱动框选选择，需要 posts 数组）与 SimilarPosts（渲染
// 瀑布流）共用同一个 queryKey，TanStack Query 会自动共享缓存，避免重复请求。
export function useSimilarPostsQuery(postId: MaybeRefOrGetter<number>) {
  const id = toRef(postId)
  return useQuery({
    ...similarPostsQueryOptions(id),
    enabled: computed(() => isValidPostId(id.value)),
  })
}
