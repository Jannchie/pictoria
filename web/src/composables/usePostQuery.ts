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
      // Locale appended: tag display names are translated server-side, so a
      // language switch refetches. invalidateQueries(queryKeys.post(id))
      // still matches by prefix.
      queryKey: [...queryKeys.post(id), resolvedLocale],
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
