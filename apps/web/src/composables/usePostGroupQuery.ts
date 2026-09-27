import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, unref } from 'vue'
import { isValidPostId, postGroupQueryOptions } from '@/shared/postQueries'

export function usePostGroupQuery(postId: MaybeRef<number | undefined>) {
  return useQuery({
    ...postGroupQueryOptions(postId),
    enabled: computed(() => isValidPostId(unref(postId))),
  })
}
