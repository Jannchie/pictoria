import type { MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, toRef } from 'vue'
import { v2GetSimilarPosts } from '@/api'

// 相似图查询。Post.vue（驱动框选选择，需要 posts 数组）与 SimilarPosts（渲染
// 瀑布流）共用同一个 queryKey，TanStack Query 会自动共享缓存，避免重复请求。
export function useSimilarPostsQuery(postId: MaybeRefOrGetter<number>) {
  const id = toRef(postId)
  return useQuery({
    queryKey: ['similarPosts', { postId: id }],
    queryFn: async () => {
      const resp = await v2GetSimilarPosts({
        path: { post_id: id.value },
      })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    enabled: computed(() => Number.isFinite(id.value)),
  })
}
