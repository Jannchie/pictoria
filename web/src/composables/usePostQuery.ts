import type { MaybeRef } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { v2GetPost } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

function isValidId(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

export function usePostQuery(id: MaybeRef<number | undefined>) {
  return useQuery(
    {
      // Locale lives in the key (folded into queryKeys.post) so a language
      // switch refetches the server-side translated tag names.
      // invalidateQueries(queryKeys.postRoot(id)) still matches by prefix.
      queryKey: queryKeys.post(id),
      queryFn: async () => {
        const post_id = unref(id)
        if (!isValidId(post_id)) {
          return null
        }
        const resp = await v2GetPost({ path: { post_id }, query: { lang: resolvedLocale.value } })
        return resp.data
      },
      enabled: () => isValidId(unref(id)),
    },
  )
}
