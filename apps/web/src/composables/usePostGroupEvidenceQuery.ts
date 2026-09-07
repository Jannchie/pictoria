import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, unref } from 'vue'
import { v2GetPostGroupEvidence } from '@/api'
import { queryKeys } from '@/shared/queryKeys'

export type { GroupEvidenceItem } from '@/api'

/**
 * Pairwise evidence behind a post's near-duplicate group: the raw distances and,
 * for the pairs the user has ruled on, their verdict. The detail panel uses the
 * verdicts to mark which members were decided by hand — those survive automatic
 * regrouping, which is not otherwise visible anywhere in the UI.
 */
export function usePostGroupEvidenceQuery(postId: MaybeRef<number | undefined>) {
  return useQuery({
    queryKey: queryKeys.postGroupEvidence(postId),
    queryFn: async () => {
      const post_id = unref(postId)
      if (post_id == null || !Number.isFinite(post_id)) {
        return []
      }
      const resp = await v2GetPostGroupEvidence({ path: { post_id } })
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
