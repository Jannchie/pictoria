# 前端全局元数据 Undo/Redo 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 pictoria 前端加一个全局命令栈，让评分/评级/caption/source/标签增删/旋转这些元数据操作可用 Ctrl+Z / Ctrl+Y 撤销重做，并弹 toast 反馈。

**Architecture:** 四层纯前端方案。`history.ts` 维护 undo/redo 命令栈（纯，无副作用依赖）；`mutations.ts` 提供"应用某值"的 `write*` 函数（写 SDK + 复用 `patchPostsInListCache` + invalidate）和捕获旧值后入栈的 `commit*` 工厂；`useGlobalUndoRedo.ts` 绑定键盘并弹 toast；各组件调用点改为走 `commit*` 工厂而非直接调 SDK。`apply`（重做）和 `revert`（撤销）调用**同一个** `write*` 函数传不同值，因此撤销自动复刻原操作的缓存 patch+invalidate 配方。

**Tech Stack:** Vue 3 Composition API、TanStack Query (`@tanstack/vue-query`)、VueUse (`@vueuse/core`)、vitest、自动生成的 `v2*` API client。

**Spec:** `docs/superpowers/specs/2026-06-02-global-undo-redo-design.md`

---

## 文件结构

新增：
- `web/src/shared/history.ts` — 命令栈 store（类型 + 栈 + push/undo/redo/clear + canUndo/canRedo）
- `web/src/shared/mutations.ts` — `write*` 应用函数 + `commit*` 命令工厂 + 纯工具函数
- `web/src/composables/useGlobalUndoRedo.ts` — 全局键盘绑定 + toast
- `web/src/test/history.test.ts` — 命令栈单测
- `web/src/test/mutations.test.ts` — 工具函数 + 工厂单测

修改：
- `web/src/shared/index.ts` — 导出新模块
- `web/src/composables/index.ts` — 导出 `useGlobalUndoRedo`
- `web/src/App.vue` — 挂载 `useGlobalUndoRedo()`
- `web/src/components/PostDetailPanel.vue` — score / rating / caption / source 走工厂
- `web/src/components/TagSelector.vue` — 加/删标签走工厂
- `web/src/components/MainSection.vue` — 批量评分 / 旋转走工厂
- `web/src/components/PostMultiSelectPanel.vue` — 批量评分 / 评级走工厂

排除（不进栈）：删除帖子、AI 计算、导入/同步、touch、选择/导航状态。

---

## Task 1: History store（命令栈，纯）

**Files:**
- Create: `web/src/shared/history.ts`
- Test: `web/src/test/history.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/test/history.test.ts`:

```ts
import type { UndoableCommand } from '@/shared/history'
import { beforeEach, describe, expect, it } from 'vitest'
import { canRedo, canUndo, clearHistory, pushCommand, redo, undo } from '@/shared/history'

function cmd(label: string, log: string[]): UndoableCommand {
  return {
    label,
    postIds: [],
    apply: async () => { log.push(`apply:${label}`) },
    revert: async () => { log.push(`revert:${label}`) },
  }
}

describe('history store', () => {
  beforeEach(() => clearHistory())

  it('undo runs revert and moves the command to the redo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    expect(canUndo.value).toBe(true)
    const r = await undo()
    expect(r.status).toBe('done')
    expect(log).toEqual(['revert:a'])
    expect(canUndo.value).toBe(false)
    expect(canRedo.value).toBe(true)
  })

  it('redo re-applies and moves the command back to the undo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    await undo()
    const r = await redo()
    expect(r.status).toBe('done')
    expect(log).toEqual(['revert:a', 'apply:a'])
    expect(canUndo.value).toBe(true)
    expect(canRedo.value).toBe(false)
  })

  it('pushing a new command clears the redo stack', async () => {
    const log: string[] = []
    pushCommand(cmd('a', log))
    await undo()
    expect(canRedo.value).toBe(true)
    pushCommand(cmd('b', log))
    expect(canRedo.value).toBe(false)
  })

  it('undo on an empty stack returns empty', async () => {
    const r = await undo()
    expect(r.status).toBe('empty')
  })

  it('a failing revert drops the command instead of moving it to redo', async () => {
    const failing: UndoableCommand = {
      label: 'boom',
      postIds: [],
      apply: async () => {},
      revert: async () => { throw new Error('gone') },
    }
    pushCommand(failing)
    const r = await undo()
    expect(r.status).toBe('failed')
    expect(canUndo.value).toBe(false)
    expect(canRedo.value).toBe(false)
  })

  it('caps history at 100 entries, dropping the oldest', async () => {
    const log: string[] = []
    for (let i = 0; i < 101; i++) {
      pushCommand(cmd(String(i), log))
    }
    const labels: string[] = []
    let r = await undo()
    while (r.status === 'done') {
      labels.push(r.command.label)
      r = await undo()
    }
    expect(labels.length).toBe(100)
    expect(labels.includes('0')).toBe(false)
    expect(labels[0]).toBe('100')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && pnpm test -- history`
Expected: FAIL，报错找不到 `@/shared/history` 模块。

- [ ] **Step 3: 实现 history.ts**

`web/src/shared/history.ts`:

```ts
import { computed, ref } from 'vue'

export interface UndoableCommand {
  /** toast 文案，如 "给 3 张图评分 5"。 */
  label: string
  /** 受影响的 post id，用于撤销后高亮定位。 */
  postIds: number[]
  /** 重做方向：把状态推回"操作之后"。 */
  apply: () => Promise<void>
  /** 撤销方向：把状态还原到"操作之前"。 */
  revert: () => Promise<void>
  /** 可选提示，撤销时附加到 toast（如批量中有未加载的 post 无法还原）。 */
  note?: string
}

export type UndoResult =
  | { status: 'empty' }
  | { status: 'done', command: UndoableCommand }
  | { status: 'failed', command: UndoableCommand, error: unknown }

const MAX_HISTORY_DEPTH = 100

const undoStack = ref<UndoableCommand[]>([])
const redoStack = ref<UndoableCommand[]>([])

export const canUndo = computed(() => undoStack.value.length > 0)
export const canRedo = computed(() => redoStack.value.length > 0)

export function pushCommand(command: UndoableCommand): void {
  undoStack.value.push(command)
  if (undoStack.value.length > MAX_HISTORY_DEPTH) {
    undoStack.value.shift()
  }
  redoStack.value = []
}

export async function undo(): Promise<UndoResult> {
  const command = undoStack.value.pop()
  if (!command) {
    return { status: 'empty' }
  }
  try {
    await command.revert()
  }
  catch (error) {
    // 丢弃该命令，不挪到 redo 栈，让栈与真实持久化状态保持一致。
    return { status: 'failed', command, error }
  }
  redoStack.value.push(command)
  return { status: 'done', command }
}

export async function redo(): Promise<UndoResult> {
  const command = redoStack.value.pop()
  if (!command) {
    return { status: 'empty' }
  }
  try {
    await command.apply()
  }
  catch (error) {
    return { status: 'failed', command, error }
  }
  undoStack.value.push(command)
  return { status: 'done', command }
}

export function clearHistory(): void {
  undoStack.value = []
  redoStack.value = []
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && pnpm test -- history`
Expected: PASS，6 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add web/src/shared/history.ts web/src/test/history.test.ts
git commit -m "feat(undo): add undo/redo command stack store"
```

---

## Task 2: mutations.ts 纯工具函数

**Files:**
- Create: `web/src/shared/mutations.ts`
- Test: `web/src/test/mutations.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/test/mutations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { captureOldValues, groupIdsByValue } from '@/shared/mutations'

describe('groupIdsByValue', () => {
  it('groups ids that share the same value', () => {
    const groups = groupIdsByValue([
      { id: 1, value: 5 },
      { id: 2, value: 3 },
      { id: 3, value: 5 },
    ])
    expect(groups.get(5)).toEqual([1, 3])
    expect(groups.get(3)).toEqual([2])
    expect(groups.size).toBe(2)
  })
})

describe('captureOldValues', () => {
  it('captures values for known posts and reports missing ids', () => {
    const posts = [{ id: 1, score: 4 }, { id: 2, score: 2 }]
    const { captured, missingIds } = captureOldValues(posts, [1, 2, 9], p => p.score)
    expect(captured).toEqual([{ id: 1, value: 4 }, { id: 2, value: 2 }])
    expect(missingIds).toEqual([9])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && pnpm test -- mutations`
Expected: FAIL，找不到 `@/shared/mutations`。

- [ ] **Step 3: 创建 mutations.ts 并实现纯工具函数**

`web/src/shared/mutations.ts`（先只写这部分，后续 Task 追加）:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && pnpm test -- mutations`
Expected: PASS，2 个用例绿。

- [ ] **Step 5: 提交**

```bash
git add web/src/shared/mutations.ts web/src/test/mutations.test.ts
git commit -m "feat(undo): add id/value grouping + old-value capture helpers"
```

---

## Task 3: write* 应用函数 + commit* 命令工厂

**Files:**
- Modify: `web/src/shared/mutations.ts`（追加）
- Test: `web/src/test/mutations.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `web/src/test/mutations.test.ts` **顶部**加 mock（放在所有 import 之后、describe 之前）和新 describe 块：

```ts
import { beforeEach, vi } from 'vitest'
import * as api from '@/api'
import { canUndo, clearHistory, redo, undo } from '@/shared/history'
import { commitRating, commitScore, commitTag } from '@/shared/mutations'

vi.mock('@/api', () => ({
  v2UpdatePostScore: vi.fn(async () => ({})),
  v2BulkUpdatePostScore: vi.fn(async () => ({})),
  v2UpdatePostRating: vi.fn(async () => ({})),
  v2BulkUpdatePostRating: vi.fn(async () => ({})),
  v2UpdatePostCaption: vi.fn(async () => ({})),
  v2UpdatePostSource: vi.fn(async () => ({})),
  v2AddTagToPost: vi.fn(async () => ({})),
  v2RemoveTagFromPost: vi.fn(async () => ({})),
  v2RotatePostImage: vi.fn(async () => ({})),
  v2GetFolders: vi.fn(async () => ({})),
  v2SearchPosts: vi.fn(async () => ({})),
}))

const qc = { invalidateQueries: vi.fn(), setQueriesData: vi.fn() } as any

describe('commit factories', () => {
  beforeEach(() => {
    clearHistory()
    vi.clearAllMocks()
  })

  it('commitScore: single uses single endpoint, pushes a command', async () => {
    await commitScore(qc, [{ id: 1, score: 2 }], [1], 5)
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 5 } })
    expect(canUndo.value).toBe(true)
  })

  it('commitScore: bulk write + grouped revert restores per-post old values', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })

    vi.clearAllMocks()
    const r = await undo()
    expect(r.status).toBe('done')
    // 旧值不同 → 分两组，各 1 个 id → 走单条端点
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 1 }, body: { score: 1 } })
    expect(api.v2UpdatePostScore).toHaveBeenCalledWith({ path: { post_id: 2 }, body: { score: 4 } })
  })

  it('commitScore: redo re-applies the new value to all ids', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }, { id: 2, score: 4 }], [1, 2], 5)
    await undo()
    vi.clearAllMocks()
    await redo()
    expect(api.v2BulkUpdatePostScore).toHaveBeenCalledWith({ query: { ids: [1, 2], score: 5 } })
  })

  it('commitScore: notes when some selected ids are not loaded', async () => {
    await commitScore(qc, [{ id: 1, score: 1 }], [1, 99], 5)
    const r = await undo()
    expect(r.status).toBe('done')
    if (r.status === 'done') {
      expect(r.command.note).toContain('未加载')
    }
  })

  it('commitRating: single uses query param endpoint', async () => {
    await commitRating(qc, [{ id: 1, rating: 0 }], [1], 3)
    expect(api.v2UpdatePostRating).toHaveBeenCalledWith({ path: { post_id: 1 }, query: { rating: 3 } })
  })

  it('commitTag: add then undo removes, redo re-adds', async () => {
    await commitTag(qc, 7, 'cat', true)
    expect(api.v2AddTagToPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })

    vi.clearAllMocks()
    await undo()
    expect(api.v2RemoveTagFromPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })

    vi.clearAllMocks()
    await redo()
    expect(api.v2AddTagToPost).toHaveBeenCalledWith({ path: { post_id: 7, tag_name: 'cat' } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && pnpm test -- mutations`
Expected: FAIL，找不到 `commitScore` / `commitRating` / `commitTag` 导出。

- [ ] **Step 3: 在 mutations.ts 追加 write* 与 commit***

在 `web/src/shared/mutations.ts` **顶部**加 import，并在文件末尾追加实现：

```ts
import type { QueryClient } from '@tanstack/vue-query'
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
```

```ts
// ---- 应用层：写 SDK + 复用乐观 patch + invalidate（apply / revert 共用）----

export async function writeScore(qc: QueryClient, ids: number[], score: number): Promise<void> {
  if (ids.length === 0) {
    return
  }
  if (ids.length === 1) {
    await v2UpdatePostScore({ path: { post_id: ids[0] }, body: { score } })
  }
  else {
    await v2BulkUpdatePostScore({ query: { ids, score } })
  }
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
  if (ids.length === 1) {
    await v2UpdatePostRating({ path: { post_id: ids[0] }, query: { rating } })
  }
  else {
    await v2BulkUpdatePostRating({ query: { ids, rating } })
  }
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
  if (add) {
    await v2AddTagToPost({ path: { post_id: id, tag_name: tagName } })
  }
  else {
    await v2RemoveTagFromPost({ path: { post_id: id, tag_name: tagName } })
  }
  qc.invalidateQueries({ queryKey: queryKeys.post(id) })
  qc.invalidateQueries({ queryKey: queryKeys.tags })
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
  pushCommand({
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
  pushCommand({
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
  pushCommand({
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
  pushCommand({
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
  pushCommand({
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
  pushCommand({
    label: ids.length === 1
      ? (clockwise ? '顺时针旋转' : '逆时针旋转')
      : `旋转 ${ids.length} 张图`,
    postIds: ids,
    apply: () => run(clockwise),
    revert: () => run(!clockwise),
  })
}
```

> 注意：`commitTag` 撤销"删除一个 auto 标签"时，重新添加会以 `is_auto=0`（手动）写入——`v2AddTagToPost` 端点不支持设置 `is_auto`。这是已知的微小保真度损失（见计划末尾"已知限制"）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && pnpm test -- mutations`
Expected: PASS，全部用例绿（含 commit factories 块）。

- [ ] **Step 5: 提交**

```bash
git add web/src/shared/mutations.ts web/src/test/mutations.test.ts
git commit -m "feat(undo): add write/commit layer for reversible metadata mutations"
```

---

## Task 4: 导出新模块

**Files:**
- Modify: `web/src/shared/index.ts`

- [ ] **Step 1: 追加导出**

把 `web/src/shared/index.ts` 改成：

```ts
// Barrel for the global client-side store. The actual state/queries live in
// focused modules so each concern (reactive state, server queries + cache
// mutations, query-key identity, rating bounds) can be reasoned about on its
// own; everything is re-exported here so `@/shared` stays the single import.

export * from './history'
export * from './mutations'
export * from './queries'
export * from './queryKeys'
export * from './ratings'
export * from './state'
```

- [ ] **Step 2: 类型检查**

Run: `cd web && pnpm build`
Expected: 构建成功，无类型错误（确认 barrel 无循环依赖问题）。

- [ ] **Step 3: 提交**

```bash
git add web/src/shared/index.ts
git commit -m "feat(undo): export history and mutations from shared barrel"
```

---

## Task 5: 全局键盘 composable + 挂载

**Files:**
- Create: `web/src/composables/useGlobalUndoRedo.ts`
- Modify: `web/src/composables/index.ts`
- Modify: `web/src/App.vue`

- [ ] **Step 1: 创建 composable**

`web/src/composables/useGlobalUndoRedo.ts`:

```ts
import { computed } from 'vue'
import { onKeyStroke, useActiveElement } from '@vueuse/core'
import { redo, undo } from '@/shared/history'
import { selectedPostIdSet } from '@/shared/state'
import { useToast } from '@/shared/toast'

/**
 * 全局 Ctrl/Cmd+Z 撤销、Ctrl+Y / Ctrl+Shift+Z 重做。
 * 输入框聚焦时不拦截，交给浏览器原生文本撤销。撤销/重做后弹 toast，
 * 并把受影响的 post 设为当前选中以便用户看到变化（选择本身不进历史栈）。
 */
export function useGlobalUndoRedo() {
  const { pushToast } = useToast()
  const activeElement = useActiveElement()
  const notUsingInput = computed(() =>
    activeElement.value?.tagName !== 'INPUT'
    && activeElement.value?.tagName !== 'TEXTAREA',
  )

  onKeyStroke(['z', 'Z', 'y', 'Y'], async (e) => {
    if (!notUsingInput.value) {
      return
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl) {
      return
    }
    const key = e.key.toLowerCase()
    const isRedo = key === 'y' || (key === 'z' && e.shiftKey)
    const isUndo = key === 'z' && !e.shiftKey
    if (!isUndo && !isRedo) {
      return
    }
    e.preventDefault()

    const result = isRedo ? await redo() : await undo()
    if (result.status === 'empty') {
      return
    }
    if (result.status === 'failed') {
      pushToast({
        type: 'error',
        message: `无法${isRedo ? '重做' : '撤销'}：${result.command.label}（帖子可能已被删除）`,
        duration: 4000,
        closeable: true,
      })
      return
    }
    // 高亮受影响的 post（不进历史栈，只是视觉聚焦）
    if (result.command.postIds.length > 0) {
      selectedPostIdSet.value = new Set(result.command.postIds)
    }
    const note = !isRedo && result.command.note ? `（${result.command.note}）` : ''
    pushToast({
      type: 'info',
      message: `${isRedo ? '已重做' : '已撤销'}：${result.command.label}${note}`,
      duration: 2500,
    })
  })
}
```

- [ ] **Step 2: 加入 composables barrel**

把 `web/src/composables/index.ts` 改成：

```ts
export { useClientHeight } from './useClientHeight'
export { useClientWidth } from './useClientWidth'
export { useFocusedPost } from './useFocusedPost'
export { useGlobalUndoRedo } from './useGlobalUndoRedo'
export { usePostQuery } from './usePostQuery'
export { useWatchRoute } from './useWatchRoute'
```

- [ ] **Step 3: 在 App.vue 挂载**

在 `web/src/App.vue` 的 `<script setup>` 中：
- 把第 7 行 `import { useWatchRoute } from './composables'` 改为：

```ts
import { useGlobalUndoRedo, useWatchRoute } from './composables'
```

- 在第 12 行 `useWatchRoute()` 下面加一行：

```ts
useWatchRoute()
useGlobalUndoRedo()
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd web && pnpm build`
Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add web/src/composables/useGlobalUndoRedo.ts web/src/composables/index.ts web/src/App.vue
git commit -m "feat(undo): add global Ctrl+Z/Ctrl+Y keybinding with toast feedback"
```

---

## Task 6: 接入 PostDetailPanel（score / rating / caption / source）

**Files:**
- Modify: `web/src/components/PostDetailPanel.vue`

- [ ] **Step 1: 改 import**

把第 5 行的 SDK import 中**只保留 AI 用的两个**，其余改走工厂。具体：
- 第 5 行 `import { v2GetSilvaScorerOne, v2GetWaifuScorerOne, v2UpdatePostCaption, v2UpdatePostRating, v2UpdatePostScore, v2UpdatePostSource } from '@/api'`
  改为：

```ts
import { v2GetSilvaScorerOne, v2GetWaifuScorerOne } from '@/api'
```

- 第 7 行的 `@/shared` import 追加 `commitCaption, commitRating, commitScore, commitSource`：

```ts
import { commitCaption, commitRating, commitScore, commitSource, hideNSFW, openTagSelectorWindow, patchPostsInListCache, queryKeys, showPostDetail } from '@/shared'
```

> `patchPostsInListCache`、`queryKeys` 仍被其他逻辑用到则保留；构建报未使用再删。

- [ ] **Step 2: 改 onSelectScore（第 21-49 行）**

把整个 `onSelectScore` 函数体替换为：

```ts
async function onSelectScore(post_id: number, score: number = 0) {
  await commitScore(queryClient, [props.post], [post_id], score)
}
```

- [ ] **Step 3: 改 rating @select（第 266-273 行模板内联 handler）**

把 Rating 的 `@select` 内联 handler：

```html
              @select="async (d) => v2UpdatePostRating({
                path: {
                  post_id: post.id,
                },
                query: {
                  rating: d,
                },
              })"
```

替换为：

```html
              @select="(d) => commitRating(queryClient, [post], [post.id], d)"
```

- [ ] **Step 4: 改 updateCaption（第 101-112 行）**

替换为：

```ts
const updateCaption = useDebounceFn(async (caption: string) => {
  await commitCaption(queryClient, post.value.id, post.value.caption ?? '', caption)
}, 500)
```

- [ ] **Step 5: 改 updateSource（第 114-125 行）**

替换为：

```ts
const updateSource = useDebounceFn(async (source: string) => {
  await commitSource(queryClient, post.value.id, post.value.source ?? '', source)
}, 500)
```

- [ ] **Step 6: 类型检查 + 构建 + lint**

Run: `cd web && pnpm build && pnpm lint`
Expected: 构建成功；lint 通过（若报 `v2UpdatePostRating` 等已无人用，删掉残留 import）。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/PostDetailPanel.vue
git commit -m "feat(undo): route post-detail score/rating/caption/source through undo stack"
```

---

## Task 7: 接入 TagSelector（加 / 删标签）

**Files:**
- Modify: `web/src/components/TagSelector.vue`

- [ ] **Step 1: 改 import**

在 TagSelector 的 `<script setup>` import 区加：

```ts
import { commitTag } from '@/shared'
```

（`v2AddTagToPost` / `v2RemoveTagFromPost` 若改造后无人直接调用，删掉其 import。）

- [ ] **Step 2: 改 onPointerUp（第 91-111 行）**

把函数体替换为：

```ts
async function onPointerUp(tagName: string) {
  if (!postId.value) {
    return
  }
  const isOn = currentTags.value.some(tag => tag.tagInfo.name === tagName)
  // 已在 post 上 → 移除（add=false）；否则 → 添加（add=true）
  await commitTag(queryClient, postId.value, tagName, !isOn)
}
```

- [ ] **Step 3: 改 addTag（第 133-149 行）**

把函数体替换为：

```ts
async function addTag(tagName: string) {
  if (!postId.value) {
    return
  }
  await commitTag(queryClient, postId.value, tagName, true)
}
```

- [ ] **Step 4: 类型检查 + 构建 + lint**

Run: `cd web && pnpm build && pnpm lint`
Expected: 成功；删掉无用 import 后无告警。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/TagSelector.vue
git commit -m "feat(undo): route tag add/remove through undo stack"
```

---

## Task 8: 接入 MainSection（批量评分 / 旋转）

**Files:**
- Modify: `web/src/components/MainSection.vue`

- [ ] **Step 1: 改 import**

在 MainSection 的 `@/shared` import 中追加 `commitRotate, commitScore`。在脚本中找到从 `@/shared` 导入的那一行，把这两个名字加进去（保留其余已有导入）。例如若当前是 `import { patchPostsInListCache, queryKeys, selectedPostIdSet, ... } from '@/shared'`，改为包含 `commitRotate, commitScore`。

- [ ] **Step 2: 改 applyScoreToSelection（第 296-321 行）**

把整个函数体替换为：

```ts
async function applyScoreToSelection(score: number) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  if (ids.length === 0) {
    return
  }
  await commitScore(queryClient, posts.value, ids, score)
}
```

> `posts` 是本组件已有的画廊列表（第 330 行 `posts.value.map` 在用）。`updateScoreForSelectedPosts` / `patchPostsInListCache` 在此处不再需要——若构建提示 import 未使用，删除对应名字。

- [ ] **Step 3: 改 onMenuSelect 的旋转分支（第 468-489 行）**

把整个 `onMenuSelect` 函数替换为：

```ts
async function onMenuSelect(value: string | number | symbol) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  switch (value) {
    case 'rotate-clockwise': {
      await commitRotate(queryClient, ids, true)
      break
    }
    case 'rotate-counterclockwise': {
      await commitRotate(queryClient, ids, false)
      break
    }
    case 'delete': {
      requestDelete()
      break
    }
  }
}
```

- [ ] **Step 4: 删除不再使用的 rotateImageMutation（第 467 行）**

删掉 `const rotateImageMutation = useRotateImageMutation()`，并删掉其 `import { useRotateImageMutation } from '...'`（若构建提示未使用）。

- [ ] **Step 5: 类型检查 + 构建 + lint**

Run: `cd web && pnpm build && pnpm lint`
Expected: 成功；清掉残留未用 import 后无告警。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/MainSection.vue
git commit -m "feat(undo): route gallery bulk-score and rotate through undo stack"
```

---

## Task 9: 接入 PostMultiSelectPanel（批量评级 / 评分）

**Files:**
- Modify: `web/src/components/PostMultiSelectPanel.vue`

- [ ] **Step 1: 改 import**

在 `@/shared` import 中追加 `commitRating, commitScore`。

- [ ] **Step 2: 改 applyRating（第 238-244 行）**

替换为：

```ts
async function applyRating(rating: number) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  await commitRating(queryClient, selectedPosts.value, ids, rating)
}
```

- [ ] **Step 3: 改 applyScore（第 246-252 行）**

替换为：

```ts
async function applyScore(score: number) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  await commitScore(queryClient, selectedPosts.value, ids, score)
}
```

> `selectedPosts` 是本组件已有的已加载选中列表（第 255 行 `selectedPosts.value.map` 在用），含 rating/score 旧值。未加载的 id 由 `captureOldValues` 标为 missing，撤销时 toast 会注明。`updateRatingForSelectedPosts`/`updateScoreForSelectedPosts`/`patchPostsInListCache`/`queryKeys` 在此处可能不再使用——按构建提示清理。

- [ ] **Step 4: 类型检查 + 构建 + lint**

Run: `cd web && pnpm build && pnpm lint`
Expected: 成功。

- [ ] **Step 5: 提交**

```bash
git add web/src/components/PostMultiSelectPanel.vue
git commit -m "feat(undo): route multi-select panel rating/score through undo stack"
```

---

## Task 10: 全量验证（自动 + 手动）

**Files:** 无（验证）

- [ ] **Step 1: 跑全部单测**

Run: `cd web && pnpm test`
Expected: 全绿，含 `history.test.ts`、`mutations.test.ts`、既有测试。

- [ ] **Step 2: lint + 构建**

Run: `cd web && pnpm lint && pnpm build`
Expected: 无 lint 错误、构建成功。

- [ ] **Step 3: 手动冒烟（需要后端在跑）**

启动 `just dev`（或 `just server-dev` + `just web-dev`），在浏览器里逐项验证：

1. 单条评分：在详情面板给一张图评分 → `Ctrl+Z` 还原旧分、弹「已撤销：评分 → N」→ `Ctrl+Y` 重做。
2. 评级：改评级 → `Ctrl+Z` 还原（确认 UI 立即回退，验证新增的乐观 patch 生效）。
3. caption：编辑描述框、点别处使其失焦 → `Ctrl+Z`（焦点不在输入框）还原；在输入框内打字时 `Ctrl+Z` 仍是浏览器原生文本撤销，不触发全局栈。
4. 标签：在 TagSelector 点一个标签加上 → `Ctrl+Z` 移除 → `Ctrl+Y` 加回。
5. 批量评分：画廊多选几张，按 `3` 批量评分 → `Ctrl+Z` 各自回到原分（验证不同旧值分组还原）。
6. 旋转：右键选中项旋转 → `Ctrl+Z` 反向旋回。
7. 多级：连续做 3 个操作 → `Ctrl+Z` 三次逐步回退 → `Ctrl+Y` 三次逐步重做。
8. 新操作清 redo：撤销一次后做个新操作 → `Ctrl+Y` 无效（redo 栈已清）。
9. 撤销已删除帖子的操作：评分后删除该帖子（多选删除）→ `Ctrl+Z` 弹错误 toast「无法撤销…」且不崩。
10. 删除本身不可撤销：删除帖子后 `Ctrl+Z` 不应恢复帖子（删除不进栈）。

- [ ] **Step 4: 收尾提交（如手动验证中发现并修了小问题）**

```bash
git add -A
git commit -m "fix(undo): address issues found in manual verification"
```

（无问题则跳过。）

---

## 自检（写完计划后对照 spec）

- **覆盖**：score/rating（单+批量）= Task 6/8/9；caption/source = Task 6；标签加删 = Task 7；旋转 = Task 8。✅ 与 spec 范围一致。
- **键盘 + toast**：Task 5。✅
- **生命周期默认值**：深度 100（Task 1）；刷新即清空（内存 ref，天然）；不随路由清空（无清空触发器）；陈旧 = last-writer-wins + 删除报错处理（Task 1 failed 分支 + Task 5 错误 toast）；文本框原生撤销（Task 5 notUsingInput 守卫）；批量 missing 尽力而为（Task 2/3 + note）。✅
- **排除项**：删除/AI/导入/touch/选择均未接工厂。✅

## 已知限制（实现时如实保留，验证后告知用户）

1. **旋转非字节级可逆**：反向旋转是重编码，质量会缓慢损耗。逻辑正确。
2. **撤销"删除 auto 标签"会以手动标签身份加回**：`v2AddTagToPost` 端点不支持 `is_auto`。可接受。
3. **批量全选未加载页的 post**：旧值不在缓存，撤销时尽力而为并 toast 注明 N 张未还原。
4. **撤销会改变当前选择**（高亮受影响 post）：选择本身不进历史栈，是视觉聚焦的副作用。若不想要，删 `useGlobalUndoRedo` 里设置 `selectedPostIdSet` 的两行即可。
5. **多客户端/后台 worker 并发**：撤销以捕获的旧值覆盖，可能盖掉期间的更新。本地单用户可接受。
