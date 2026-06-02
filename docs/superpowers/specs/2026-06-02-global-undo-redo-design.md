# 前端全局元数据 Undo/Redo 设计

- **日期**: 2026-06-02
- **范围**: 仅前端（Vue 3 + TanStack Query）。不改后端，不引入软删除/回收站。
- **状态**: 已确认，待实现计划

## 背景

Pictoria 当前没有任何 undo/redo、命令栈、变更日志、软删除或回收站机制（前后端均为绿地）。`Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z` 全部空闲。

写操作分散在各组件里直接调用 ~12 个 `v2*` SDK 函数（评分甚至是模板内联 handler），只有 3 处用了 `useMutation`。没有统一的写入入口。现成可复用的乐观更新原语是 `patchPostsInListCache`（`web/src/shared/queries.ts:109`），现成的 toast 是 `useToast().pushToast`（`web/src/shared/toast.ts`）。

## 目标与非目标

### 覆盖范围（进栈）

仅**元数据类**、有干净逆操作的写操作：

- 单条 评分 (score) / 评级 (rating)
- caption / source 文本
- 标签 加 / 删（单条 post）
- 旋转图片（CW/CCW）
- 批量 评分 / 评级（基于选中集）

### 非目标（不进栈）

- **删除帖子**：硬删 DB 行 + 从磁盘 unlink 原图和缩略图（`server/src/db/repositories/posts.py:162`），且会从读接口 `images.py:69` 隐式触发。维持现有"二次确认 + This cannot be undone"。
- **AI 计算**：auto-tags / auto-caption / waifu / silva 打分 / embedding——非确定性、昂贵、多表。
- **导入 / 同步**：Danbooru 下载、sync-metadata、upload。
- **touch**（浏览计时）、内部 failure 记录、DB snapshot。
- **选择 / 导航状态**（选中哪些图、当前打开哪张、滚动位置）——纯前端状态，不进栈。

## 架构

四层，纯前端：

```
键盘层    useGlobalUndoRedo()   ← Ctrl/Cmd+Z, Ctrl+Y, Ctrl+Shift+Z（notUsingInput 守卫）
   │
History store   shared/history.ts   ← undoStack / redoStack + push / undo / redo / clear
   │
Command 工厂    各调用点：读旧值 → apply() → pushCommand({ apply, revert })
   │
Apply 层    shared/queries.ts 扩展   ← 写 SDK + patchPostsInListCache + invalidate（apply / revert 共用）
```

### 核心设计点

`apply`（重做方向）和 `revert`（撤销方向）调用**同一个**"应用某值"函数（如 `applyScore(ids, value)`），只是传入不同的值。这样撤销时**自动复刻**操作原本的缓存 patch + invalidate 配方，避免"评级内联 handler 没 patch 缓存、撤销后 UI 不一致"。这是选择「逆命令栈」而非「状态快照栈」的关键理由。

### Command 接口

```ts
interface UndoableCommand {
  label: string          // toast 文案，如 "给 3 张图评 5 分"
  postIds: number[]      // 撤销离屏 post 时定位/高亮
  apply: () => Promise<void>   // 重做方向
  revert: () => Promise<void>  // 撤销方向
}
```

### History store（`web/src/shared/history.ts`）

与现有 `shared/state.ts` 一致，用模块级 `ref`（无 Pinia）：

```ts
const undoStack = ref<UndoableCommand[]>([])
const redoStack = ref<UndoableCommand[]>([])
const MAX_DEPTH = 100

function pushCommand(cmd: UndoableCommand): void   // push 到 undoStack；清空 redoStack；超出 MAX_DEPTH 丢最旧
async function undo(): Promise<void>               // pop undoStack → revert() → push redoStack → toast
async function redo(): Promise<void>               // pop redoStack → apply() → push undoStack → toast
function clearHistory(): void
```

`canUndo` / `canRedo` 暴露为 computed，供 UI（若需要按钮）使用。

## 逐操作的逆操作 & 旧值捕获

| 操作 | 逆操作 | 旧值来源 |
|---|---|---|
| 单条 评分 / 评级 | set 旧值 | 命令创建时从 `queryClient.getQueryData(post(id))` 或 list 缓存读 |
| caption / source | restore 旧字符串 | 同上，**记录提交（防抖落地）时的旧值** |
| 加标签 | 删除该 link | 加成功后记录 (post_id, tag_name)；revert 只删 link，**不删可能新建的 tags 行** |
| 删标签 | 重新加 link | 记录被删 link 的 `is_auto` 标志以忠实还原 |
| 旋转 CW ↔ CCW | 反向旋转 | 无需旧值（逻辑可逆，**接受重编码有损**，非字节级一致） |
| 批量 评分 / 评级 | 按旧值分组发批量请求 | 从 list 缓存逐 id 捕获 `{ id: oldValue }` |

旧值在**命令创建时**从缓存读取（调用点目前只拿到新值）。`patchPostsInListCache` 读的是同一批缓存，因此 apply / revert 可一致地读写。

## 生命周期 & 边界策略

1. **持久化**：仅内存，刷新页面即清空（刷新后旧值已陈旧，恢复反而危险）。
2. **清空时机**：**不**随路由 / 筛选 / 选择变化清空——命令针对稳定的 `post.id`，历史是全局的。仅 `clearHistory()` 显式调用或刷新时清空。
3. **栈深度**：`MAX_DEPTH = 100`，超出丢最旧。
4. **陈旧处理**：last-writer-wins，**不做冲突检测**（本地单用户）。若目标 post 已被删除 → undo/redo 失败 → `catch` + toast「无法撤销：帖子已不存在」+ 丢弃该项，保持栈一致。
5. **文本输入**：caption / source 在输入框**聚焦时走浏览器原生 `Ctrl+Z`**；移出焦点后已提交的改动才由全局栈接管。全局键盘 handler 用 `notUsingInput`（activeElement 非 INPUT/TEXTAREA）守卫，与现有快捷键一致。
6. **批量旧值边界**：`Ctrl+A` 全选可能选到**未加载页**的 post，缓存里没有其旧值。采用**尽力而为**：从缓存捕获到的部分精确还原，toast 注明「N 张未能撤销（未加载）」。**不**加后端端点（保持纯前端）。

## 键盘绑定（`useGlobalUndoRedo` composable）

- `Ctrl+Z`（Mac `Cmd+Z`）→ `undo()`
- `Ctrl+Y` 或 `Ctrl+Shift+Z`（Mac `Cmd+Shift+Z`）→ `redo()`
- 全部用 `notUsingInput` 守卫；输入框内交给浏览器原生处理。
- 在 App 根（或 MainSection）挂载一次，全局生效。

避开的已占用键：digits 1-5（评分）、`Ctrl+A`（全选）、`Delete`、方向键、`Esc`、查看器的 `+/=/-/0/\`、`f/F`、TagSelector 的 `Tab/Arrows/Enter`。

## UX 反馈

- 复用 `shared/toast.ts`：撤销/重做后弹「已撤销：{label}」/「已重做：{label}」。
- 撤销离屏 post 时，尽力滚动 / 高亮到首个受影响 post（用 `postIds[0]` + 现有 `currentPostList` / 滚动机制），让用户看到变化。
- **不**给 toast 加"撤销"按钮（已有 Ctrl+Z，YAGNI）；`ToastData` 不扩展。

## 调用点改造清单

将下列直接调用 SDK 的写操作，改为通过 command 工厂（读旧值 → apply → pushCommand）：

- `PostDetailPanel.vue`：onSelectScore（含 1-5 键）、rating `@select` 内联 handler、caption / source 防抖提交。
- `TagSelector.vue`：onPointerUp 的 add/remove、addTag。
- `MainSection.vue`：applyScoreToSelection（1-5 键批量）、context menu 旋转。
- `PostMultiSelectPanel.vue`：applyRating / applyScore 批量。
- `shared/queries.ts`：将 `updateScoreForSelectedPosts` / `updateRatingForSelectedPosts` 及单条写逻辑抽成可复用的 `applyXxx(ids, value)`（含 patch + invalidate），供 apply / revert 共用。

> 旋转复用现有 `useRotateImageMutation`；其逆是反向旋转，包成 command。

## 测试（vitest）

- **history store**：push / undo / redo；新操作清空 redo 栈；深度上限（第 101 个挤掉最旧）；`clearHistory`。
- **command 工厂**：从缓存读旧值；revert 正确还原（单条 + 批量分组）；目标 post 已删除时的错误处理（toast + 丢弃 + 栈一致）。
- mock `queryClient` + `v2*` SDK 函数。

## 风险与已知限制

- **旋转非字节级可逆**：图片重编码有损，多次旋转-撤销会累积质量损失。逻辑上正确。
- **批量未加载 post**：尽力而为，部分不可撤销，已 toast 提示。
- **多客户端 / 后台 worker 并发**：若后台 AI worker 在操作与撤销之间改了同一 post，撤销会以旧值覆盖较新改动（last-writer-wins）。本地单用户场景可接受。
- **隐式删除**：`images.py:69` 在文件丢失时隐式删 post；不在本设计覆盖范围（删除整体不可撤销）。
