import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, unref } from 'vue'
import { v2GetPostGroup } from '@/api'
import { queryKeys } from '@/shared/queryKeys'

// Near-duplicate group members of a canonical post — the hidden lower-resolution
// copies / differentials that the listings collapse behind it. Returns [] for a
// post that heads no group.
export function usePostGroupQuery(postId: MaybeRef<number | undefined>) {
  return useQuery({
    queryKey: queryKeys.postGroup(postId),
    queryFn: async () => {
      const post_id = unref(postId)
      if (post_id == null || !Number.isFinite(post_id)) {
        return []
      }
      const resp = await v2GetPostGroup({ path: { post_id } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data ?? []
    },
    enabled: computed(() => {
      const id = unref(postId)
      return id != null && Number.isFinite(id)
    }),
  })
}
