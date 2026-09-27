import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, unref } from 'vue'
import { isValidPostId, postGroupEvidenceQueryOptions } from '@/shared/postQueries'

export type { GroupEvidenceItem } from '@/api'

/**
 * Pairwise evidence behind a post's near-duplicate group: the raw distances and,
 * for the pairs the user has ruled on, their verdict. The detail panel uses the
 * verdicts to mark which members were decided by hand — those survive automatic
 * regrouping, which is not otherwise visible anywhere in the UI.
 */
export function usePostGroupEvidenceQuery(postId: MaybeRef<number | undefined>) {
  return useQuery({
    ...postGroupEvidenceQueryOptions(postId),
    enabled: computed(() => isValidPostId(unref(postId))),
  })
}
