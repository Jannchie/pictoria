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
import { resolvedLocale } from '@/locale'

export type CountKind = 'rating' | 'score' | 'extension' | 'waifu' | 'silva' | 'tags'

export const queryKeys = {
  /** Infinite gallery list, keyed by the full request body. */
  posts: (body: unknown) => ['posts', body] as const,
  /** Prefix that matches every `posts` query (list + stats) for invalidation. */
  postsRoot: ['posts'] as const,
  /** Footer aggregate stats for a filter. */
  postsStats: (filter: unknown) => ['posts', 'stats', filter] as const,
  postsStatsRoot: ['posts', 'stats'] as const,

  /**
   * Single post detail. `resolvedLocale` is folded into the tail because tag
   * display names are translated server-side, so a language switch must
   * refetch (the ref is kept live so query declarations stay reactive). Use
   * `postRoot(id)` for invalidation — a 2-element prefix that still matches
   * every locale variant of the detail query.
   */
  post: (id: MaybeRef<number | undefined>) => ['post', id, resolvedLocale] as const,
  /** Locale-agnostic invalidation prefix for a post's detail query. */
  postRoot: (id: MaybeRef<number | undefined>) => ['post', id] as const,
  /** Similar-posts grid for a post (ref-keyed for reactive sharing). */
  similarPosts: (id: MaybeRef<number>) => ['similarPosts', { postId: id }] as const,
  /** Near-duplicate group members for a canonical post (ref-keyed). */
  postGroup: (id: MaybeRef<number | undefined>) => ['postGroup', id] as const,

  /** Per-bucket counts (rating/score/extension/waifu) for a filter. */
  count: (kind: CountKind, filter: unknown) => ['count', kind, filter] as const,
  /** Prefix matching every count query of one kind, for invalidation. */
  countRoot: (kind: CountKind) => ['count', kind] as const,
  /**
   * Denominator for TagFilter's per-tag percentage: the number of posts
   * matching the filter with the tags facet cleared. A distinct `tags-total`
   * sub-kind (not a mutually-exclusive facet, so it isn't a `CountKind`).
   */
  tagsTotalCount: (filter: unknown) => ['count', 'tags-total', filter] as const,

  /** SigLIP text-to-image search results. */
  textSearch: (prompt: string, filter: unknown) => ['textSearch', prompt, filter] as const,

  /**
   * Tag catalogue. Locale folded into the tail (server-side translated names),
   * so a language switch refetches; `tagsRoot` is the all-locale invalidation
   * prefix.
   */
  tags: () => ['tags', resolvedLocale] as const,
  tagsRoot: ['tags'] as const,
  tagGroups: (postId: MaybeRef<number | undefined>) => ['tagGroups', postId] as const,
  folders: ['folders'] as const,
  postCount: ['post-count'] as const,
  /** Background gallery-dl URL import task status (Settings page polls this). */
  urlImportStatus: ['urlImportStatus'] as const,

  /** Annotation queue list (Annotate view). */
  annotationQueues: ['annotation-queues'] as const,
  /** Per-post annotation history (ref-keyed for reactive per-post caching). */
  annotations: (postId: MaybeRef<number | undefined>) => ['annotations', postId] as const,
}
