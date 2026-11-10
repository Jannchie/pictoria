import { QueryClient } from '@tanstack/vue-query'

/**
 * The app's QueryClient (boot.ts hands it to `VueQueryPlugin`).
 *
 * `shallow: true` for every query: vue-query's default wraps `data` in a deep
 * `reactive` + `readonly` proxy, which buys nothing here — query data is never
 * edited in place (the readonly layer already blocked that, and cache writes
 * replace references through `setQueryData` / `setQueriesData`) — and costs a
 * WeakMap lookup per property read. That cost was measured on the gallery list
 * (tens of thousands of posts), the tag catalogue (a search went from
 * ~160–570 ms to ~30–80 ms) and the folder tree, which each used to opt out
 * one by one. With shallow data, a view updates when the query hands back a
 * new reference, which structural sharing does for whatever changed.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        shallow: true,
      },
    },
  })
}
