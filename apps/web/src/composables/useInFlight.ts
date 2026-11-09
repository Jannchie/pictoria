import { reactive } from 'vue'

/**
 * Keys (usually post ids) with a request in flight, shared per `scope` at
 * module level rather than per component instance: a spinner survives its
 * panel being remounted, and a remounted button can't resend a request that
 * is still running. Keyed rather than a single flag because a reused panel
 * that switches to another post must not inherit the previous post's spinner
 * (or blocked click).
 */
export interface InFlight<K> {
  has: (key: K) => boolean
  /** Run `fn` for `key` unless one is already in flight for it (then a no-op). */
  run: (key: K, fn: () => Promise<void>) => Promise<void>
}

const scopes = new Map<string, Set<unknown>>()

export function useInFlight<K extends string | number>(scope: string): InFlight<K> {
  let keys = scopes.get(scope) as Set<K> | undefined
  if (!keys) {
    keys = reactive(new Set<K>()) as Set<K>
    scopes.set(scope, keys)
  }
  const inFlight = keys

  return {
    has: key => inFlight.has(key),
    async run(key, fn) {
      if (inFlight.has(key)) {
        return
      }
      inFlight.add(key)
      try {
        await fn()
      }
      finally {
        inFlight.delete(key)
      }
    },
  }
}
