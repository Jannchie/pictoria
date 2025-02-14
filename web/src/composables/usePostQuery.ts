import type { MaybeRef } from 'vue'
import { v1GetPost } from '@/api'
import { useQuery } from '@tanstack/vue-query'

export function usePostQuery(id: MaybeRef<number | undefined>) {
  return useQuery(
    {
      queryKey: ['post', id],
      queryFn: async () => {
        const post_id = unref(id)
        if (post_id === undefined) {
          return {}
        }
        const resp = await v1GetPost({ path: { post_id } })
        return resp.data
      },
      enabled: id !== undefined,
      staleTime: Infinity,
    },
  )
}
