import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { v2GetPost } from '@/api'

export function usePostQuery(id: MaybeRef<number | undefined>) {
  return useQuery(
    {
      queryKey: ['post', id],
      queryFn: async () => {
        const post_id = unref(id)
        if (post_id === undefined) {
          return null
        }
        const resp = await v2GetPost({ path: { post_id } })
        return resp.data
      },
      enabled: id !== undefined,
    },
  )
}
