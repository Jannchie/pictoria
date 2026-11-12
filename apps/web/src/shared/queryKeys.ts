/**
 * Centralized TanStack Query keys.
 *
 * One source of truth for cache identity. Before this, key arrays like
 * `['count', 'score', filter]` were spelled out at every query declaration and
 * every `invalidateQueries` call site, so a typo in one place silently broke
 * cache sharing/invalidation with no type error to catch it. Construct keys
 * here instead; the structural invalidation predicates (which match keys by
 * position) are `queryKeys.match.*`, next to the shapes they match.
 */

import type { MaybeRef } from 'vue'
import { resolvedLocale } from '@/locale'
import { SCORERS } from './scorers'

/**
 * Every per-bucket facet count kind. The array is the source of truth (the type
 * is derived from it) so aggregate invalidation can iterate it — a hand-copied
 * list at each delete site had already drifted (it missed the scorer kinds,
 * so deleting posts left those facet counts stale). The scorer kinds
 * come from the scorer table, so adding a scorer adds its count kind.
 */
export const COUNT_KINDS = ['rating', 'score', 'extension', ...SCORERS.map(s => s.countKind), 'tags'] as const
export type CountKind = typeof COUNT_KINDS[number]

type Key = readonly unknown[]

function idIn(k: Key, ids: ReadonlySet<number> | undefined): boolean {
  return ids === undefined || (typeof k[1] === 'number' && ids.has(k[1]))
}

/**
 * Structural key matchers for `predicate`-style cache operations. They match
 * by position against the shapes the factory below builds, so the shape and
 * its matcher live in one file. With `ids`, the id slot must be a number in
 * the set.
 */
const match = {
  /** A post detail query (`post`), any locale. */
  post: (k: Key, ids?: ReadonlySet<number>): boolean => k[0] === 'post' && idIn(k, ids),
  /** A near-duplicate group query (`postGroup` / `postGroupEvidence`). */
  postGroup: (k: Key, ids?: ReadonlySet<number>): boolean => k[0] === 'postGroup' && idIn(k, ids),
  /** A facet count query; with `kind`, only that kind. */
  count: (k: Key, kind?: CountKind): boolean => k[0] === 'count' && (kind === undefined || k[1] === kind),
  /** The footer aggregate stats (`postsStats`). */
  postsStats: (k: Key): boolean => k[0] === 'posts' && k[1] === 'stats',
  /** A gallery list (`posts` / `unratedArtistPicks`): second slot is the request object, not `'stats'`. */
  postList: (k: Key): boolean => k[0] === 'posts' && typeof k[1] === 'object' && k[1] !== null,
  /** A post's annotation history (`annotations`). */
  annotations: (k: Key, ids?: ReadonlySet<number>): boolean => k[0] === 'annotations' && idIn(k, ids),
  /** A flat `Post[]` list keyed off its own prefix (text search / similar / group members). */
  flatPostList: (k: Key): boolean => k[0] === 'textSearch' || k[0] === 'similarPosts' || k[0] === 'postGroup',
}

export const queryKeys = {
  /** Infinite gallery list, keyed by the full request body. */
  posts: (body: unknown) => ['posts', body] as const,
  /**
   * The `/unrated-artists` gallery list (one pick per never-scored artist). Its
   * second element is an object on purpose: `patchPostsInListCache` patches any
   * `['posts', <object>]` list, so a star given here updates the tile in place
   * instead of refetching (which would drop the now-rated artist and shift the
   * list under the cursor). Also covered by `postsRoot` invalidation.
   */
  unratedArtistPicks: ['posts', { view: 'unratedArtists' }] as const,
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
  /**
   * Per-pair near-duplicate evidence for a post. Deliberately nested under the
   * `postGroup` prefix so one grouping edit invalidates the members and their
   * evidence together (the pin badges are read off this).
   */
  postGroupEvidence: (id: MaybeRef<number | undefined>) => ['postGroup', id, 'evidence'] as const,

  /** Per-bucket counts (rating/score/extension/silva) for a filter. */
  count: (kind: CountKind, filter: unknown) => ['count', kind, filter] as const,
  /** Prefix matching every count query of one kind, for invalidation. */
  countRoot: (kind: CountKind) => ['count', kind] as const,
  /**
   * Denominator for TagFilter's per-tag percentage: the number of posts
   * matching the filter with the tags facet cleared. A distinct `tags-total`
   * sub-kind (not a mutually-exclusive facet, so it isn't a `CountKind`).
   */
  tagsTotalCount: (filter: unknown) => ['count', 'tags-total', filter] as const,
  tagsTotalCountRoot: ['count', 'tags-total'] as const,
  /** Command-palette tag autocomplete (small top-N, keyed on query + scope + locale). */
  tagSuggest: (params: unknown) => ['count', 'tag-suggest', params] as const,

  /** SigLIP text-to-image search results. */
  textSearch: (prompt: string, filter: unknown) => ['textSearch', prompt, filter] as const,

  /**
   * Tag catalogue. Locale folded into the tail (server-side translated names),
   * so a language switch refetches; `tagsRoot` is the all-locale invalidation
   * prefix.
   */
  tags: () => ['tags', resolvedLocale] as const,
  tagsRoot: ['tags'] as const,
  /**
   * 语义分类树（danbooru-tags-tree）。分类名是服务端按 lang 解析的，所以和
   * `tags` 一样把 locale 折进 key。
   *
   * **刻意不在 `tagsRoot` 前缀下**：树是 API 进程首次使用时从
   * `server/data/tag-tree.json` 读一次的静态表（`apps/api/src/tag-tree.ts`），没有
   * 任何写端点会改变它。放在 `['tags', …]` 下时，每次给图加/删 tag（writeTag 失效
   * `tagsRoot`）都会白白重取整棵树。没有写操作需要失效它。
   */
  tagTree: () => ['tagTree', resolvedLocale] as const,
  // 无参：`v2ListTagGroup` 返回的是全局分组表，与 post 无关。带上 postId 的话
  // 同一份数据会按 post 各缓存一份、各请求一次。
  tagGroups: () => ['tagGroups'] as const,
  folders: ['folders'] as const,
  postCount: ['post-count'] as const,
  /** Background gallery-dl URL import task status (Settings page polls this). */
  urlImportStatus: ['urlImportStatus'] as const,
  /** Backfill progress + cairnq queue depths (sidebar sync-status area polls this). */
  queuesStatus: ['queuesStatus'] as const,

  /** Annotation queue list (Annotate view). */
  annotationQueues: ['annotation-queues'] as const,
  /** The quick-grade page's live agreement figures. */
  gradingStats: ['grading', 'stats'] as const,
  /** The quick-grade page's fixed reference pictures. */
  gradingAnchors: ['grading', 'anchors'] as const,
  /** Per-post annotation history (ref-keyed for reactive per-post caching). */
  annotations: (postId: MaybeRef<number | undefined>) => ['annotations', postId] as const,
  /** Prefix matching every per-post annotation history. */
  annotationsRoot: ['annotations'] as const,
  /**
   * The global annotation stream behind the session history sidebar. One key,
   * no parameters: it is always "everything, newest first", and the session
   * prepends its own submissions into this cache rather than refetching (a
   * refetch of an infinite query re-runs every loaded page, once per judgement).
   */
  annotationTimeline: ['annotation-timeline'] as const,

  /** Predicate helpers matching the shapes above (see `match`). */
  match,
}
