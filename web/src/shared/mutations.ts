import type { QueryClient } from '@tanstack/vue-query'
import type { UndoableCommand } from './history'
import {
  v2AddTagToPost,
  v2BulkUpdatePostRating,
  v2BulkUpdatePostScore,
  v2RemoveTagFromPost,
  v2RotatePostImage,
  v2UpdatePostCaption,
  v2UpdatePostRating,
  v2UpdatePostScore,
  v2UpdatePostSource,
} from '@/api'
import { pushCommand } from './history'
import { patchPostsInListCache } from './queries'
import { queryKeys } from './queryKeys'
import { notifyDid } from './undoSnackbar'

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

export async function writeScore(qc: QueryClient, ids: number[], score: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await (ids.length === 1 ? v2UpdatePostScore({ path: { post_id: ids[0] }, body: { score } }) : v2BulkUpdatePostScore({ query: { ids, score } }))
  patchPostsInListCache(qc, ids, { score })
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
      return k[0] === 'post' && typeof k[1] === 'number' && idSet.has(k[1])
    },
  })
}

export async function writeRating(qc: QueryClient, ids: number[], rating: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  await (ids.length === 1 ? v2UpdatePostRating({ path: { post_id: ids[0] }, query: { rating } }) : v2BulkUpdatePostRating({ query: { ids, rating } }))
  patchPostsInListCache(qc, ids, { rating })
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

export async function writeCaption(qc: QueryClient, id: number, caption: string): Promise<void> {
  await v2UpdatePostCaption({ path: { post_id: id }, query: { caption } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
}

export async function writeSource(qc: QueryClient, id: number, source: string): Promise<void> {
  await v2UpdatePostSource({ path: { post_id: id }, query: { source } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
}

export async function writeTag(qc: QueryClient, id: number, tagName: string, add: boolean): Promise<void> {
  await (add ? v2AddTagToPost({ path: { post_id: id, tag_name: tagName } }) : v2RemoveTagFromPost({ path: { post_id: id, tag_name: tagName } }))
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
  qc.invalidateQueries({ queryKey: queryKeys.tags })
  // The tag-filter facet counts (per-tag post totals) shift when a post gains or
  // loses a tag, so refresh every tag-count query.
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
}

export async function writeRotate(qc: QueryClient, id: number, clockwise: boolean): Promise<void> {
  await v2RotatePostImage({ path: { post_id: id }, query: { clockwise } })
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
}

// ---- 命令工厂：捕获旧值 → 执行 → 入栈 ----

function buildNote(missingIds: number[]): string | undefined {
  return missingIds.length > 0 ? `${missingIds.length} 张未加载，无法撤销` : undefined
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
    label: ids.length === 1 ? `评分 → ${newScore}` : `给 ${ids.length} 张图评分 ${newScore}`,
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
    label: ids.length === 1 ? `评级 → ${newRating}` : `给 ${ids.length} 张图评级 ${newRating}`,
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
    label: '编辑描述',
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
    label: '编辑来源',
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
    label: add ? `添加标签 ${tagName}` : `移除标签 ${tagName}`,
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
      ? (clockwise ? '顺时针旋转' : '逆时针旋转')
      : `旋转 ${ids.length} 张图`,
    postIds: ids,
    apply: () => run(clockwise),
    revert: () => run(!clockwise),
  })
}
