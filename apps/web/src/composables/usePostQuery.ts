import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { isValidPostId, postQueryOptions } from '@/shared/postQueries'

export function usePostQuery(id: MaybeRef<number | undefined>) {
  return useQuery({
    ...postQueryOptions(id),
    enabled: () => isValidPostId(unref(id)),
  })
}
