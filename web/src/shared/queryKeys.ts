/**
 * Centralized TanStack Query keys.
 *
 * One source of truth for cache identity. Before this, key arrays like
 * `['count', 'score', filter]` were spelled out at every query declaration and
 * every `invalidateQueries` call site, so a typo in one place silently broke
 * cache sharing/invalidation with no type error to catch it. Construct keys
 * here instead; the structural invalidation predicates (which match key
 * prefixes* by position) still live at their call sites by necessity.
 */

import type { MaybeRef } from 'vue'

export type CountKind = 'rating' | 'score' | 'extension' | 'waifu' | 'silva' | 'tags'

export const queryKeys = {
  /** Infinite gallery list, keyed by the full request body. */
  posts: (body: unknown) => ['posts', body] as const,
  /** Prefix that matches every `posts` query (list + stats) for invalidation. */
  postsRoot: ['posts'] as const,
  /** Footer aggregate stats for a filter. */
  postsStats: (filter: unknown) => ['posts', 'stats', filter] as const,
  postsStatsRoot: ['posts', 'stats'] as const,

  /** Single post detail. Accepts a ref so query declarations keep reactivity. */
  post: (id: MaybeRef<number | undefined>) => ['post', id] as const,
  /** Similar-posts grid for a post (ref-keyed for reactive sharing). */
  similarPosts: (id: MaybeRef<number>) => ['similarPosts', { postId: id }] as const,

  /** Per-bucket counts (rating/score/extension/waifu) for a filter. */
  count: (kind: CountKind, filter: unknown) => ['count', kind, filter] as const,
  /** Prefix matching every count query of one kind, for invalidation. */
  countRoot: (kind: CountKind) => ['count', kind] as const,

  /** SigLIP text-to-image search results. */
  textSearch: (prompt: string, filter: unknown) => ['textSearch', prompt, filter] as const,

  tags: ['tags'] as const,
  tagGroups: (postId: MaybeRef<number | undefined>) => ['tagGroups', postId] as const,
  folders: ['folders'] as const,
  postCount: ['post-count'] as const,
}
