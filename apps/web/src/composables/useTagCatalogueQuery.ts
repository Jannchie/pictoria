import type { MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toValue } from 'vue'
import { v2ListTags } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

/**
 * The whole tag catalogue (tens of thousands of rows, with per-tag counts and
 * the server-side translated names). One query definition for the Tags page,
 * the tag editor (TagSelector) and the batch "Add tag…" picker — they share the
 * cache entry, so they must agree on how it is fetched and held.
 *
 * - Locale lives in the key (`queryKeys.tags`), so a language switch refetches;
 *   `invalidateQueries(queryKeys.tagsRoot)` still matches by prefix.
 * - A failed request throws: swallowing it into `[]` would cache an empty
 *   catalogue (for good, under `staleTime: Infinity`).
 * - `structuralSharing: false`: every response is a brand-new array, so the
 *   field-by-field deep compare finds nothing to reuse and costs more than the
 *   parse.
 * - `shallow: true`: read-only rows; deep reactive proxies made every property
 *   read in a search loop a WeakMap lookup (a search went from ~160–570 ms to
 *   ~30–80 ms without them).
 */
export function useTagCatalogueQuery(options: { enabled?: MaybeRefOrGetter<boolean>, staleTime?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.tags(),
    queryFn: async () => {
      const resp = await v2ListTags({ query: { lang: resolvedLocale.value } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    enabled: () => toValue(options.enabled ?? true),
    staleTime: options.staleTime,
    structuralSharing: false,
    shallow: true,
  })
}
