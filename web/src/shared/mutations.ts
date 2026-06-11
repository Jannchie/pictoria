import type { QueryClient } from '@tanstack/vue-query'
import type { UndoableCommand } from './history'
import {
  v2AddTagToPost,
  v2BulkUpdatePostRating,
  v2BulkUpdatePostScore,
  v2DeleteFolder,
  v2DeletePosts,
  v2MakePostCanonical,
  v2RemoveTagFromPost,
  v2RotatePostImage,
  v2UngroupPost,
  v2UpdatePostCaption,
  v2UpdatePostRating,
  v2UpdatePostScore,
  v2UpdatePostSource,
} from '@/api'
import { i18n } from '@/locale'
import { pushCommand } from './history'
import { patchPostsInListCache } from './queries'
import { queryKeys } from './queryKeys'
import { postSort } from './state'
import { notifyDid } from './undoSnackbar'

// Non-component module: go through the global composer. History labels are
// rendered at action time, so entries keep the language they were created in.
const t = i18n.global.t

// Push a command onto the undo stack AND surface the bottom snackbar. Every
// commit* factory records through here so a single user action always produces
// exactly one history entry and one popup.
function record(command: UndoableCommand): void {
  pushCommand(command)
  notifyDid(command.label)
}

export interface IdValue<T> {
  id: number
  value: T
}

/** 把 (id, value) 列表按 value 分组，供批量撤销时按旧值分批发请求。 */
export function groupIdsByValue<T>(entries: IdValue<T>[]): Map<T, number[]> {
  const groups = new Map<T, number[]>()
  for (const { id, value } of entries) {
    const ids = groups.get(value)
    if (ids) {
      ids.push(id)
    }
    else {
      groups.set(value, [id])
    }
  }
  return groups
}

/**
 * 从一批已知 post 中读取每个 id 的旧值；缓存里没有的 id 记入 missingIds
 * （批量"尽力而为"撤销：未加载的 post 旧值不可知，无法还原）。
 */
export function captureOldValues<P extends { id: number }, T>(
  posts: P[],
  ids: number[],
  read: (post: P) => T,
): { captured: IdValue<T>[], missingIds: number[] } {
  const byId = new Map(posts.map(p => [p.id, p]))
  const captured: IdValue<T>[] = []
  const missingIds: number[] = []
  for (const id of ids) {
    const post = byId.get(id)
    if (post) {
      captured.push({ id, value: read(post) })
    }
    else {
      missingIds.push(id)
    }
  }
  return { captured, missingIds }
}

// ---- 应用层：写 SDK + 复用乐观 patch + invalidate（apply / revert 共用）----

// 批量端点把 ids 作为重复 query 参数传输；select-all 轻易产出上千个 id，
// 一次性发送会超出服务器的请求行长度上限（请求整体被拒）。所有批量写
// 一律按 100 个分批。
const BULK_BATCH_SIZE = 100
async function inBatches(ids: number[], run: (chunk: number[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
    await run(ids.slice(i, i + BULK_BATCH_SIZE))
  }
}

async function writeScore(qc: QueryClient, ids: number[], score: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await (ids.length === 1
    ? v2UpdatePostScore({ path: { post_id: ids[0] }, body: { score } })
    : inBatches(ids, chunk => v2BulkUpdatePostScore({ query: { ids: chunk, score } })))
  // When the gallery is sorted by this very field, the per-item sort badge
  // echoes sortValue — patch it too so the badge doesn't show the stale value.
  patchPostsInListCache(qc, ids, postSort.value === 'score' ? { score, sortValue: score } : { score })
  const idSet = new Set(ids)
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      if (!Array.isArray(k)) {
        return false
      }
      if (k[0] === 'count' && k[1] === 'score') {
        return true
      }
      if (k[0] === 'posts' && k[1] === 'stats') {
        return true
      }
      // Scoring a canonical mirrors the score onto its hidden group members
      // (server-side), so refresh both the post detail and the "same group"
      // member panel (postGroup) for every scored id.
      return (k[0] === 'post' || k[0] === 'postGroup') && typeof k[1] === 'number' && idSet.has(k[1])
    },
  })
}

async function writeRating(qc: QueryClient, ids: number[], rating: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await (ids.length === 1
    ? v2UpdatePostRating({ path: { post_id: ids[0] }, query: { rating } })
    : inBatches(ids, chunk => v2BulkUpdatePostRating({ query: { ids: chunk, rating } })))
  patchPostsInListCache(qc, ids, postSort.value === 'rating' ? { rating, sortValue: rating } : { rating })
  const idSet = new Set(ids)
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      if (!Array.isArray(k)) {
        return false
      }
      if (k[0] === 'count' && k[1] === 'rating') {
        return true
      }
      if (k[0] === 'posts' && k[1] === 'stats') {
        return true
      }
      return k[0] === 'post' && typeof k[1] === 'number' && idSet.has(k[1])
    },
  })
}

async function writeCaption(qc: QueryClient, id: number, caption: string): Promise<void> {
  await v2UpdatePostCaption({ path: { post_id: id }, query: { caption } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
}

async function writeSource(qc: QueryClient, id: number, source: string): Promise<void> {
  await v2UpdatePostSource({ path: { post_id: id }, query: { source } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
}

async function writeTag(qc: QueryClient, id: number, tagName: string, add: boolean): Promise<void> {
  await (add ? v2AddTagToPost({ path: { post_id: id, tag_name: tagName } }) : v2RemoveTagFromPost({ path: { post_id: id, tag_name: tagName } }))
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
  qc.invalidateQueries({ queryKey: queryKeys.tags })
  // The tag-filter facet counts (per-tag post totals) shift when a post gains or
  // loses a tag, so refresh every tag-count query.
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
}

async function writeRotate(qc: QueryClient, id: number, clockwise: boolean): Promise<void> {
  await v2RotatePostImage({ path: { post_id: id }, query: { clockwise } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
}

// ---- 删除：从所有列表缓存剔除 + 刷新计数 ----

// A PostSimplePublic list lives in the cache under two shapes: the gallery's
// infinite query is `{ pages: Post[][] }`, while text-search / similar-posts /
// group-member queries are a flat `Post[]`. Deleting a post must drop it from
// whichever shape a given cache entry uses. (The old delete path only ran
// `invalidate(['posts'])`, which never matched the latter three — different key
// prefixes — so deleting from those grids left the card on screen.)
export function removePostsFromCacheEntry(old: unknown, idSet: Set<number>): unknown {
  if (!old) {
    return old
  }
  // infinite-list shape: { pages: Post[][], pageParams }
  if (typeof old === 'object' && Array.isArray((old as { pages?: unknown }).pages)) {
    const o = old as { pages: (Array<{ id?: number }> | undefined)[], pageParams: unknown[] }
    return {
      ...o,
      pages: o.pages.map(page =>
        Array.isArray(page) ? page.filter(p => !(p && p.id != null && idSet.has(p.id))) : page,
      ),
    }
  }
  // flat-array shape: text-search / similar / group results
  if (Array.isArray(old)) {
    return (old as Array<{ id?: number }>).filter(p => !(p && p.id != null && idSet.has(p.id)))
  }
  return old
}

function removeDeletedPostsFromCaches(qc: QueryClient, ids: number[]): void {
  const idSet = new Set(ids)
  qc.setQueriesData<unknown>(
    {
      predicate: (q) => {
        const k = q.queryKey
        if (!Array.isArray(k)) {
          return false
        }
        // gallery infinite list ['posts', <body object>]; exclude ['posts','stats',…]
        if (k[0] === 'posts') {
          return typeof k[1] === 'object' && k[1] !== null
        }
        // flat-array post lists keyed off their own prefixes
        return k[0] === 'textSearch' || k[0] === 'similarPosts' || k[0] === 'postGroup'
      },
    },
    (old: unknown) => removePostsFromCacheEntry(old, idSet),
  )
}

/**
 * Delete posts and refresh every view that could still show them. Drops the
 * rows from all list caches (gallery + text-search + similar + group) so the
 * card disappears immediately, then invalidates the cheap count/stats
 * aggregates. The expensive vector searches (text/similar) are patched in place
 * rather than re-run.
 */
export async function deletePosts(qc: QueryClient, ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await inBatches(ids, chunk => v2DeletePosts({ query: { ids: chunk } }))
  removeDeletedPostsFromCaches(qc, ids)
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('score') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('rating') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('extension') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
  qc.invalidateQueries({ queryKey: queryKeys.postsStatsRoot })
  // The sidebar folder tree's per-folder counts/averages come from the folders
  // query (staleTime 1h) — without this it kept showing pre-delete numbers.
  qc.invalidateQueries({ queryKey: queryKeys.folders })
  qc.invalidateQueries({ queryKey: queryKeys.postCount })
}

/** Delete a library folder (its posts, files and the directory tree). Not undoable. */
export async function deleteFolder(qc: QueryClient, folder: string): Promise<void> {
  await v2DeleteFolder({ path: { folder_path: folder } })
  // A whole subtree of posts disappeared — refresh the tree, every post list
  // and all the facet/stat counts (we don't know which ids were inside).
  qc.invalidateQueries({ queryKey: queryKeys.folders })
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('score') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('rating') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('extension') })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
  qc.invalidateQueries({ queryKey: queryKeys.postsStatsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.postCount })
}

// Near-duplicate grouping edits shift which posts are canonical/visible, so they
// touch the gallery list, the footer stats, the tag-facet counts and every
// affected post detail + group query. invalidate broadly (these are infrequent
// manual actions, so a slightly wide refresh is cheaper than tracking exactly
// which sibling ids moved).
function invalidateGrouping(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.postsStatsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      return Array.isArray(k) && (k[0] === 'post' || k[0] === 'postGroup')
    },
  })
}

/** Detach a post from its near-duplicate group (make it standalone/visible). */
export async function ungroupPost(qc: QueryClient, id: number): Promise<void> {
  await v2UngroupPost({ path: { post_id: id } })
  invalidateGrouping(qc)
}

/** Promote a group member to be the group's canonical representative. */
export async function makePostCanonical(qc: QueryClient, id: number): Promise<void> {
  await v2MakePostCanonical({ path: { post_id: id } })
  invalidateGrouping(qc)
}

// ---- 命令工厂：捕获旧值 → 执行 → 入栈 ----

function buildNote(missingIds: number[]): string | undefined {
  return missingIds.length > 0 ? t('history.notLoaded', { n: missingIds.length }) : undefined
}

function revertGrouped<T>(
  qc: QueryClient,
  captured: IdValue<T>[],
  write: (qc: QueryClient, ids: number[], value: T) => Promise<void>,
): () => Promise<void> {
  return async () => {
    for (const [value, ids] of groupIdsByValue(captured)) {
      await write(qc, ids, value)
    }
  }
}

export async function commitScore(
  qc: QueryClient,
  posts: Array<{ id: number, score: number }>,
  ids: number[],
  newScore: number,
): Promise<{ missingIds: number[] }> {
  const { captured, missingIds } = captureOldValues(posts, ids, p => p.score)
  await writeScore(qc, ids, newScore)
  record({
    label: ids.length === 1 ? t('history.setScore', { score: newScore }) : t('history.setScoreMany', { n: ids.length, score: newScore }),
    postIds: ids,
    apply: () => writeScore(qc, ids, newScore),
    revert: revertGrouped(qc, captured, writeScore),
    note: buildNote(missingIds),
  })
  return { missingIds }
}

export async function commitRating(
  qc: QueryClient,
  posts: Array<{ id: number, rating: number }>,
  ids: number[],
  newRating: number,
): Promise<{ missingIds: number[] }> {
  const { captured, missingIds } = captureOldValues(posts, ids, p => p.rating)
  await writeRating(qc, ids, newRating)
  record({
    label: ids.length === 1 ? t('history.setRating', { rating: newRating }) : t('history.setRatingMany', { n: ids.length, rating: newRating }),
    postIds: ids,
    apply: () => writeRating(qc, ids, newRating),
    revert: revertGrouped(qc, captured, writeRating),
    note: buildNote(missingIds),
  })
  return { missingIds }
}

export async function commitCaption(
  qc: QueryClient,
  id: number,
  oldCaption: string,
  newCaption: string,
): Promise<void> {
  await writeCaption(qc, id, newCaption)
  record({
    label: t('history.editCaption'),
    postIds: [id],
    apply: () => writeCaption(qc, id, newCaption),
    revert: () => writeCaption(qc, id, oldCaption),
  })
}

export async function commitSource(
  qc: QueryClient,
  id: number,
  oldSource: string,
  newSource: string,
): Promise<void> {
  await writeSource(qc, id, newSource)
  record({
    label: t('history.editSource'),
    postIds: [id],
    apply: () => writeSource(qc, id, newSource),
    revert: () => writeSource(qc, id, oldSource),
  })
}

export async function commitTag(
  qc: QueryClient,
  id: number,
  tagName: string,
  add: boolean,
): Promise<void> {
  await writeTag(qc, id, tagName, add)
  record({
    label: add ? t('history.addTag', { tag: tagName }) : t('history.removeTag', { tag: tagName }),
    postIds: [id],
    apply: () => writeTag(qc, id, tagName, add),
    revert: () => writeTag(qc, id, tagName, !add),
  })
}

export async function commitRotate(
  qc: QueryClient,
  ids: number[],
  clockwise: boolean,
): Promise<void> {
  const run = async (cw: boolean) => {
    for (const id of ids) {
      await writeRotate(qc, id, cw)
    }
  }
  await run(clockwise)
  record({
    label: ids.length === 1
      ? (clockwise ? t('history.rotateCw') : t('history.rotateCcw'))
      : t('history.rotateMany', { n: ids.length }),
    postIds: ids,
    apply: () => run(clockwise),
    revert: () => run(!clockwise),
  })
}
