import type { QueryClient } from '@tanstack/vue-query'
import type { UndoableCommand } from './history'
import type { ScorerKind } from './scorers'
import type {
  V2EditAnnotationData,
  V2GenerateAbsoluteData,
  V2GenerateListwiseData,
  V2GeneratePairwiseData,
  V2SubmitAbsoluteData,
  V2SubmitContentFlagData,
  V2SubmitListwiseData,
  V2SubmitPairwiseData,
  V2UndoAnnotationsData,
  V2UploadFileData,
} from '@/api'
import {
  v2AddTagToPost,
  v2AutoCaption,
  v2AutoTags,
  v2BulkAddTagToPosts,
  v2BulkRemoveTagFromPosts,
  v2BulkUpdatePostRating,
  v2BulkUpdatePostScore,
  v2DeleteFolder,
  v2DeletePosts,
  v2DeleteQueue,
  v2EditAnnotation,
  v2GenerateAbsolute,
  v2GenerateListwise,
  v2GeneratePairwise,
  v2GetSilvaLunaScorerOne,
  v2GetSilvaScorerOne,
  v2GetWaifuScorerOne,
  v2GroupPostsTogether,
  v2ImportFromUrlEndpoint,
  v2MakePostCanonical,
  v2MarkPostsDifferent,
  v2RemoveTagFromPost,
  v2RotatePostImage,
  v2SetPostTagSource,
  v2SubmitAbsolute,
  v2SubmitContentFlag,
  v2SubmitListwise,
  v2SubmitPairwise,
  v2TouchPost,
  v2UndoAnnotations,
  v2UngroupPost,
  v2UpdatePostCaption,
  v2UpdatePostRating,
  v2UpdatePostScore,
  v2UpdatePostSource,
  v2UploadFile,
} from '@/api'
import { i18n } from '@/locale'
import { pushCommand } from './history'
import { patchPostsInListCache } from './queries'
import { COUNT_KINDS, queryKeys } from './queryKeys'
import { SCORERS } from './scorers'
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

/**
 * 乐观补详情缓存。detail key 是 `['post', id, locale]`（`queryKeys.post`），
 * 用谓词按 id 匹配，locale 维度全部照打。
 *
 * 这一步和 `patchPostsInListCache` 一起挪到了 **await 之前**：原来是「等更新
 * 请求返回 → 补列表 → 失效详情 → 再等一次重取」两个串行往返，backfill 落库
 * 占着 API 那条同步 sqlite 连接时，点星到生效有可感知的延迟。现在缓存先行、
 * 请求随后，失败路径以服务端为准重取覆盖（见各 write* 的 catch）。
 */
function patchPostDetailCaches(qc: QueryClient, ids: number[], patch: Record<string, unknown>): void {
  const idSet = new Set(ids)
  qc.setQueriesData<Record<string, unknown>>(
    { predicate: q => queryKeys.match.post(q.queryKey, idSet) },
    old => (old ? { ...old, ...patch } : old),
  )
}

/** 乐观写失败后的回滚：本地假值已经上屏，只能以服务端为准全部重取。 */
function refetchTruth(qc: QueryClient, ids: number[]): void {
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
  for (const id of ids) {
    qc.invalidateQueries({ queryKey: queryKeys.postRoot(id) })
  }
}

async function writeScore(qc: QueryClient, ids: number[], score: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  // When the gallery is sorted by this very field, the per-item sort badge
  // echoes sortValue — patch it too so the badge doesn't show the stale value.
  patchPostsInListCache(qc, ids, postSort.value === 'score' ? { score, sortValue: score } : { score })
  patchPostDetailCaches(qc, ids, { score })
  try {
    await (ids.length === 1
      ? v2UpdatePostScore({ path: { post_id: ids[0] }, body: { score } })
      : inBatches(ids, chunk => v2BulkUpdatePostScore({ query: { ids: chunk, score } })))
  }
  catch (error) {
    refetchTruth(qc, ids)
    throw error
  }
  const idSet = new Set(ids)
  const { match } = queryKeys
  qc.invalidateQueries({
    predicate: ({ queryKey: k }) =>
      match.count(k, 'score')
      || match.postsStats(k)
      // Scoring a canonical mirrors the score onto its hidden group members
      // (server-side), so refresh both the post detail and the "same group"
      // member panel (postGroup) for every scored id.
      || match.post(k, idSet)
      || match.postGroup(k, idSet),
  })
}

async function writeRating(qc: QueryClient, ids: number[], rating: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  // 乐观顺序同 writeScore：缓存先行，请求随后，失败重取覆盖。
  patchPostsInListCache(qc, ids, postSort.value === 'rating' ? { rating, sortValue: rating } : { rating })
  patchPostDetailCaches(qc, ids, { rating })
  try {
    await (ids.length === 1
      ? v2UpdatePostRating({ path: { post_id: ids[0] }, query: { rating } })
      : inBatches(ids, chunk => v2BulkUpdatePostRating({ query: { ids: chunk, rating } })))
  }
  catch (error) {
    refetchTruth(qc, ids)
    throw error
  }
  const idSet = new Set(ids)
  const { match } = queryKeys
  qc.invalidateQueries({
    predicate: ({ queryKey: k }) => match.count(k, 'rating') || match.postsStats(k) || match.post(k, idSet),
  })
}

async function writeCaption(qc: QueryClient, id: number, caption: string): Promise<void> {
  await v2UpdatePostCaption({ path: { post_id: id }, query: { caption } })
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(id) })
}

async function writeSource(qc: QueryClient, id: number, source: string): Promise<void> {
  await v2UpdatePostSource({ path: { post_id: id }, query: { source } })
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(id) })
}

/**
 * 单张加 / 摘标签。`isAuto` 只对加生效：撤销"摘掉自动标签"时要按自动行放回去，
 * 端点的可选 body 让"加回 + 标成自动"在一个请求（一个事务）里完成。普通的加不带
 * body —— 那样 axios 不发 `Content-Type: application/json`，服务端也就不会去解析
 * 一个空 body。
 */
async function writeTag(qc: QueryClient, id: number, tagName: string, add: boolean, { isAuto = false }: { isAuto?: boolean } = {}): Promise<void> {
  const path = { post_id: id, tag_name: tagName }
  await (add
    ? v2AddTagToPost(isAuto ? { path, body: { isAuto: true } } : { path })
    : v2RemoveTagFromPost({ path }))
  invalidateTagWrite(qc, [id], tagName)
}

/** 标签来源（人工 / 自动）只影响这张图的详情；计数和标签目录都不变。 */
async function writeTagSource(qc: QueryClient, id: number, tagName: string, isAuto: boolean): Promise<void> {
  await v2SetPostTagSource({ path: { post_id: id, tag_name: tagName }, body: { isAuto } })
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(id) })
}

/**
 * 旋转一批图，**整批做完才失效一次**。
 *
 * 失效原来写在每张图后面。`queryKeys.postsRoot` 命中的是那条 infinite 画廊查询，
 * 而失效一个 active 的 infinite query 会把**已加载的每一页**依次重取（同一个坑
 * `AnnotationTimeline.vue:29` 的注释里记过）。于是 Ctrl+A 之后右键旋转 200 张
 * = 200 次写往返 + 200 轮整表重取，已加载 10 页时最坏 2000 次 `/v2/posts/search`,
 * 而 `queries.ts:23` 实测过非索引排序每页 231–243 ms 的同步阻塞。
 *
 * 详情 key 逐个失效仍留在这里：那些查询除了当前聚焦的那张之外都是 inactive，
 * 失效只是打个 stale 标记，不会触发重取。
 *
 * 写请求保持串行：旋转在服务端是一次重新编码，并发发出去只是把排队挪个地方，
 * 而它占的是 API 那条同步 sqlite 连接的同一个进程。
 */
async function writeRotate(qc: QueryClient, ids: number[], clockwise: boolean): Promise<void> {
  for (const id of ids) {
    await v2RotatePostImage({ path: { post_id: id }, query: { clockwise } })
  }
  for (const id of ids) {
    qc.invalidateQueries({ queryKey: queryKeys.postRoot(id) })
  }
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
}

// ---- 聚合失效：计数 / 统计 ----

/**
 * Invalidate every aggregate that summarises "which posts exist": each facet
 * count kind (driven off `COUNT_KINDS`, so a new kind can't be forgotten here
 * the way waifu / silva / silvaLuna were), TagFilter's `tags-total`
 * denominator, the footer stats and the special-path post counts. Count
 * queries are popover-gated, so this mostly marks them stale rather than
 * refetching. `folders` also refreshes the sidebar tree's per-folder numbers.
 */
export function invalidateAggregates(qc: QueryClient, opts: { folders?: boolean } = {}): void {
  for (const kind of COUNT_KINDS) {
    qc.invalidateQueries({ queryKey: queryKeys.countRoot(kind) })
  }
  qc.invalidateQueries({ queryKey: queryKeys.tagsTotalCountRoot })
  qc.invalidateQueries({ queryKey: queryKeys.postsStatsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.postCount })
  if (opts.folders) {
    qc.invalidateQueries({ queryKey: queryKeys.folders, refetchType: 'none' })
  }
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
      // gallery infinite list ['posts', <body object>] (not ['posts','stats',…]),
      // plus the flat-array post lists keyed off their own prefixes
      predicate: ({ queryKey: k }) => queryKeys.match.postList(k) || queryKeys.match.flatPostList(k),
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
  // The sidebar folder tree's per-folder counts/averages come from the folders
  // query (staleTime 1h) — without `folders` it kept showing pre-delete numbers.
  invalidateAggregates(qc, { folders: true })
}

/** Delete a library folder (its posts, files and the directory tree). Not undoable. */
export async function deleteFolder(qc: QueryClient, folder: string): Promise<void> {
  await v2DeleteFolder({ path: { folder_path: folder } })
  // A whole subtree of posts disappeared — refresh the tree, every post list
  // and all the facet/stat counts (we don't know which ids were inside).
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
  invalidateAggregates(qc, { folders: true })
}

// Near-duplicate grouping edits shift which posts are canonical/visible, so they
// touch the gallery list, the footer stats, the tag-facet counts and every
// affected post detail + group query. invalidate broadly (these are infrequent
// manual actions, so a slightly wide refresh is cheaper than tracking exactly
// which sibling ids moved).
function invalidateGrouping(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
  invalidateAggregates(qc)
  qc.invalidateQueries({
    predicate: ({ queryKey: k }) => queryKeys.match.post(k) || queryKeys.match.postGroup(k),
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

/**
 * Merge posts into one near-duplicate group. Resolves to the group's canonical
 * id (which may be a post outside `ids` when they joined an existing group).
 */
export async function groupPostsTogether(
  qc: QueryClient,
  ids: number[],
  canonicalId?: number,
): Promise<number | null> {
  const resp = await v2GroupPostsTogether({ body: { ids, canonicalId } })
  invalidateGrouping(qc)
  // 回的是**封面**的详情，可能不是 ids 里的任何一张（并进一个已有的组时）。
  return resp.data?.id ?? null
}

/** Record that two posts are not the same picture (and split them apart now). */
export async function markPostsDifferent(
  qc: QueryClient,
  postId: number,
  otherId: number,
): Promise<void> {
  await v2MarkPostsDifferent({ path: { post_id: postId, other_id: otherId } })
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

/**
 * 加 / 摘一个标签。摘的是自动标签时传 `wasAuto`：撤销要把它按自动标签放回去
 * （一次 `PUT` 带 `{ isAuto: true }`）—— 只加回人工行的话，撤销一次删除等于顺手
 * "确认"了它。
 */
export async function commitTag(
  qc: QueryClient,
  id: number,
  tagName: string,
  add: boolean,
  { wasAuto = false }: { wasAuto?: boolean } = {},
): Promise<void> {
  const restore = () => writeTag(qc, id, tagName, true, { isAuto: wasAuto })
  const remove = () => writeTag(qc, id, tagName, false)
  await (add ? restore() : remove())
  record({
    label: add ? t('history.addTag', { tag: tagName }) : t('history.removeTag', { tag: tagName }),
    postIds: [id],
    apply: add ? restore : remove,
    revert: add ? remove : restore,
  })
}

/** Most posts the bulk tag endpoints take in one request (one transaction each). */
export const TAG_BULK_LIMIT = 5000

/** Whether every cached tag catalogue already lists `tagName` (no catalogue cached counts as yes). */
function catalogueHasTag(qc: QueryClient, tagName: string): boolean {
  return qc.getQueriesData<{ name: string }[]>({ queryKey: queryKeys.tagsRoot })
    .every(([, tags]) => !tags || tags.some(tag => tag.name === tagName))
}

/**
 * After posts gained / lost a tag: their details and the tag-filter facet
 * counts are stale (one predicate pass). The tag catalogue is refetched only
 * when the tag is new to it; otherwise only its per-tag counts moved, so it is
 * just marked stale (re-read by the next page that mounts it) — refetching the
 * whole multi-MB catalogue after every tag click was the expensive part.
 */
function invalidateTagWrite(qc: QueryClient, ids: readonly number[], tagName: string): void {
  const idSet = new Set(ids)
  const { match } = queryKeys
  qc.invalidateQueries({ predicate: ({ queryKey: k }) => match.post(k, idSet) || match.count(k, 'tags') })
  qc.invalidateQueries({ queryKey: queryKeys.tagsRoot, refetchType: catalogueHasTag(qc, tagName) ? 'none' : 'active' })
}

/**
 * Add (or remove) one tag on many posts through the bulk endpoint, one
 * request (= one server transaction) per `TAG_BULK_LIMIT` posts, invalidating
 * once at the end. The server reports which posts actually changed (`done`)
 * and which were already in the target state (`unchanged`: had / lacked the
 * tag). A failed request stops the run; the chunks before it are committed, so
 * what they did is still returned (with the error) so it can be undone.
 */
async function applyTagMany(
  qc: QueryClient,
  ids: readonly number[],
  tagName: string,
  add: boolean,
): Promise<{ done: number[], unchanged: number[], error?: unknown }> {
  const done = new Set<number>()
  const unchanged = new Set<number>()
  let error: unknown
  try {
    for (let i = 0; i < ids.length; i += TAG_BULK_LIMIT) {
      const options = { path: { tag_name: tagName }, body: { postIds: ids.slice(i, i + TAG_BULK_LIMIT) } }
      if (add) {
        const { data } = await v2BulkAddTagToPosts(options)
        for (const id of data?.added ?? []) done.add(id)
        for (const id of data?.already ?? []) unchanged.add(id)
      }
      else {
        const { data } = await v2BulkRemoveTagFromPosts(options)
        for (const id of data?.removed ?? []) done.add(id)
        for (const id of data?.absent ?? []) unchanged.add(id)
      }
    }
  }
  catch (error_) {
    error = error_
  }
  invalidateTagWrite(qc, ids, tagName)
  // Input order, whatever order the server listed them in.
  return { done: ids.filter(id => done.has(id)), unchanged: ids.filter(id => unchanged.has(id)), error }
}

/** applyTagMany for undo / redo: a post already in the target state is fine. */
async function replayTagMany(qc: QueryClient, ids: readonly number[], tagName: string, add: boolean): Promise<void> {
  const { error } = await applyTagMany(qc, ids, tagName, add)
  if (error) {
    throw error
  }
}

/**
 * 给多选里的每一张加同一个标签（多选面板的"添加标签…"）。已经有这个标签的图
 * （服务端回在 `already` 里）不算这次操作的一部分：记进撤销栈的只有真正加上的
 * 那些，撤销只摘它们 —— 否则撤销会顺手摘掉原本就有的标签。超过一批的上限时，
 * 中途失败的话前面已提交的批次照样入栈（可撤销），错误再抛给调用方。
 */
export async function commitTagMany(
  qc: QueryClient,
  ids: readonly number[],
  tagName: string,
): Promise<{ done: number[], already: number[] }> {
  const { done, unchanged, error } = await applyTagMany(qc, ids, tagName, true)
  if (done.length > 0) {
    record({
      label: done.length === 1 ? t('history.addTag', { tag: tagName }) : t('history.addTagMany', { tag: tagName, n: done.length }),
      postIds: done,
      apply: () => replayTagMany(qc, done, tagName, true),
      revert: () => replayTagMany(qc, done, tagName, false),
    })
  }
  if (error) {
    throw error
  }
  return { done, already: unchanged }
}

/** 把一个自动标签确认为人工（`isAuto = false`），或改回自动。 */
export async function commitTagSource(
  qc: QueryClient,
  id: number,
  tagName: string,
  isAuto: boolean,
): Promise<void> {
  await writeTagSource(qc, id, tagName, isAuto)
  record({
    label: isAuto ? t('history.unconfirmTag', { tag: tagName }) : t('history.confirmTag', { tag: tagName }),
    postIds: [id],
    apply: () => writeTagSource(qc, id, tagName, isAuto),
    revert: () => writeTagSource(qc, id, tagName, !isAuto),
  })
}

export async function commitRotate(
  qc: QueryClient,
  ids: number[],
  clockwise: boolean,
): Promise<void> {
  const run = (cw: boolean) => writeRotate(qc, ids, cw)
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

// ---- 单帖的服务端计算：打分器 / 自动标签 / 自动描述 ----

const SCORE_ONE: Record<ScorerKind, (postId: number) => Promise<unknown>> = {
  waifu: postId => v2GetWaifuScorerOne({ path: { post_id: postId } }),
  silva: postId => v2GetSilvaScorerOne({ path: { post_id: postId } }),
  silvaLuna: postId => v2GetSilvaLunaScorerOne({ path: { post_id: postId } }),
}

/**
 * Run one scorer on one post (the endpoint is a GET, but it computes and
 * persists the score). Refreshes the post detail and that scorer's facet
 * counts; waifu also refreshes the footer stats (the only scorer they carry an
 * average for). A scorer that feeds the sidebar folders' per-folder averages
 * marks the folder tree stale without refetching it — `/v2/folders` takes
 * seconds server-side, too much for one score click; it picks the new average
 * up on its next natural fetch.
 */
export async function computeScore(qc: QueryClient, kind: ScorerKind, postId: number): Promise<void> {
  await SCORE_ONE[kind](postId)
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(postId) })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot(kind) })
  if (kind === 'waifu') {
    qc.invalidateQueries({ queryKey: queryKeys.postsStatsRoot })
  }
  if (SCORERS.find(s => s.countKind === kind)?.feedsFolderAggregates) {
    qc.invalidateQueries({ queryKey: queryKeys.folders, refetchType: 'none' })
  }
}

/**
 * Auto-tag one post. New tags shift the tag catalogue's per-tag counts and the
 * tag-facet counts, same as a manual tag edit (`writeTag`).
 */
export async function autoTagPost(qc: QueryClient, postId: number): Promise<void> {
  await v2AutoTags({ path: { post_id: postId } })
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(postId) })
  qc.invalidateQueries({ queryKey: queryKeys.tagsRoot })
  qc.invalidateQueries({ queryKey: queryKeys.countRoot('tags') })
}

/** Auto-caption one post. */
export async function autoCaptionPost(qc: QueryClient, postId: number): Promise<void> {
  await v2AutoCaption({ path: { post_id: postId } })
  qc.invalidateQueries({ queryKey: queryKeys.postRoot(postId) })
}

// ---- 入库：上传 / URL 导入 / 访问记录 ----

/**
 * Upload one file into the library. Invalidates the gallery per file, as the
 * drop handler always has (a drop is a handful of files, and each one should
 * show up as soon as it lands).
 */
export async function uploadFile(qc: QueryClient, body: V2UploadFileData['body']): Promise<void> {
  await v2UploadFile({ body })
  qc.invalidateQueries({ queryKey: queryKeys.postsRoot })
}

/**
 * Start a background gallery-dl import. Only the task status is refreshed here;
 * the folders / gallery are refreshed when that status reaches `done`
 * (`ImportFromUrlSection` watches it).
 */
export async function startUrlImport(qc: QueryClient, url: string) {
  const resp = await v2ImportFromUrlEndpoint({ query: { url } })
  qc.invalidateQueries({ queryKey: queryKeys.urlImportStatus })
  return resp.data
}

/**
 * Stamp `last_accessed_at` (the Recently view's order). Fire-and-forget and
 * deliberately invalidates nothing: it runs on every post navigation, and
 * refetching the infinite gallery each time would re-run every loaded page.
 */
export async function touchPost(postId: number): Promise<void> {
  await v2TouchPost({ path: { post_id: postId } })
}

// ---- 标注 ----
//
// Judgements are prepended into the session-history cache by the sessions
// themselves (see annotationTimeline.ts — refetching that infinite query would
// re-run every loaded page per judgement). What is invalidated here is the
// per-post history (`queryKeys.annotations`, staleTime 30s), which otherwise
// kept showing a post's pre-session history on its detail panel. The queue
// list (`queryKeys.annotationQueues`) is not touched per judgement:
// Annotate.vue refetches it when a session exits, and it is not on screen
// while one runs.

function invalidatePostAnnotations(qc: QueryClient, postIds: Iterable<number>): void {
  const ids = new Set(postIds)
  qc.invalidateQueries({ predicate: ({ queryKey: k }) => queryKeys.match.annotations(k, ids) })
}

/** Record one pairwise judgement. Resolves to the written event ids. */
export async function submitPairwise(qc: QueryClient, body: V2SubmitPairwiseData['body']): Promise<number[]> {
  const resp = await v2SubmitPairwise({ body })
  invalidatePostAnnotations(qc, [body.postA, body.postB])
  return resp.data?.ids ?? []
}

/** Record one listwise ranking (or a skip, with an empty ranking). Resolves to the event ids. */
export async function submitListwise(qc: QueryClient, body: V2SubmitListwiseData['body']): Promise<number[]> {
  const resp = await v2SubmitListwise({ body })
  invalidatePostAnnotations(qc, body.postIds)
  return resp.data?.ids ?? []
}

/**
 * Record absolute ratings (one event per dimension; an empty `events` only
 * marks a queue item done). Resolves to the event ids, in `events` order.
 */
export async function submitAbsolute(qc: QueryClient, body: V2SubmitAbsoluteData['body']): Promise<number[]> {
  const resp = await v2SubmitAbsolute({ body })
  invalidatePostAnnotations(qc, body.events.map(e => e.postId))
  return resp.data?.ids ?? []
}

/** Record a content flag (love / hate / none). Resolves to the event ids. */
export async function submitContentFlag(qc: QueryClient, body: V2SubmitContentFlagData['body']): Promise<number[]> {
  const resp = await v2SubmitContentFlag({ body })
  invalidatePostAnnotations(qc, [body.postId])
  return resp.data?.ids ?? []
}

/**
 * Delete annotation events (the undo of a judgement) and reopen the queue item.
 * The body carries only event ids, so the caller names the posts they were about.
 */
export async function undoAnnotations(
  qc: QueryClient,
  body: V2UndoAnnotationsData['body'],
  postIds: Iterable<number>,
): Promise<void> {
  await v2UndoAnnotations({ body })
  invalidatePostAnnotations(qc, postIds)
}

/** Correct an already-submitted record's verdict in place. */
export async function editAnnotation(
  qc: QueryClient,
  kind: V2EditAnnotationData['path']['kind'],
  annotationId: number,
  verdict: V2EditAnnotationData['body']['verdict'],
  postIds: Iterable<number>,
): Promise<void> {
  await v2EditAnnotation({ path: { kind, annotation_id: annotationId }, body: { verdict } })
  invalidatePostAnnotations(qc, postIds)
}

/** Create a fixed absolute-rating queue; resolves once the queue list has refetched. */
export async function generateAbsoluteQueue(qc: QueryClient, body: V2GenerateAbsoluteData['body']): Promise<void> {
  await v2GenerateAbsolute({ body })
  await qc.invalidateQueries({ queryKey: queryKeys.annotationQueues })
}

/** Create a fixed listwise queue; resolves once the queue list has refetched. */
export async function generateListwiseQueue(qc: QueryClient, body: V2GenerateListwiseData['body']): Promise<void> {
  await v2GenerateListwise({ body })
  await qc.invalidateQueries({ queryKey: queryKeys.annotationQueues })
}

/** Create a fixed pairwise queue; resolves once the queue list has refetched. */
export async function generatePairwiseQueue(qc: QueryClient, body: V2GeneratePairwiseData['body']): Promise<void> {
  await v2GeneratePairwise({ body })
  await qc.invalidateQueries({ queryKey: queryKeys.annotationQueues })
}

/** Delete a fixed queue (its submitted judgements stay); resolves once the queue list has refetched. */
export async function deleteAnnotationQueue(qc: QueryClient, id: number): Promise<void> {
  await v2DeleteQueue({ path: { queue_id: id } })
  await qc.invalidateQueries({ queryKey: queryKeys.annotationQueues })
}
