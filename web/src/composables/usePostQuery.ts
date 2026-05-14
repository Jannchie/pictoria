import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { v2GetPost } from '@/api'

function isValidId(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

export function usePostQuery(id: MaybeRef<number | undefined>) {
  return useQuery(
    {
      queryKey: ['post', id],
      queryFn: async () => {
        const post_id = unref(id)
        if (!isValidId(post_id)) {
          return null
        }
        const resp = await v2GetPost({ path: { post_id } })
        return resp.data
      },
      enabled: () => isValidId(unref(id)),
    },
  )
}
