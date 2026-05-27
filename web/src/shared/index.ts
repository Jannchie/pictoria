// Barrel for the global client-side store. The actual state/queries live in
// focused modules so each concern (reactive state, server queries + cache
// mutations, query-key identity, rating bounds) can be reasoned about on its
// own; everything is re-exported here so `@/shared` stays the single import.

export * from './queries'
export { queryKeys } from './queryKeys'
export type { CountKind } from './queryKeys'
export * from './ratings'
export * from './state'
