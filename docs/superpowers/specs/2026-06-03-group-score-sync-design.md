# 代表图评分同步 + 按更新时间排序 设计

**日期**: 2026-06-03
**作者**: Jianqi Pan
**状态**: 待实现
**相关**: [近似重复图片分组（合并）设计](./2026-06-03-near-duplicate-grouping-design.md)

本设计含两块相关但正交的改动：(1) 给代表图评分时把分数同步给全组成员；(2) 顺带新增按
`updated_at` 排序（评分会刷新 `updated_at`，便于把最近改动过的图排到前面）。下文先写
评分同步，再写排序。

## 背景与目标

近似重复分组（见相关设计）把"几乎相同"的图片归到一组：组里 `canonical_post_id IS NULL`
的那张是**代表图**（可见、可搜），其余是**附属成员**（默认隐藏）。评分应当对整组生效——
用户给代表图打的分，就是这一组的分。

当前实现已经把代表图的 `score` 级联给成员，但带了 `AND score = 0` 守卫：**只写还没单独
评分的成员，已评分的成员保持原分**。本次目标是改成**同步给全部成员（含已评分的）**——
成员的 `score` 始终镜像它代表图的 `score`。

## 行为语义（定稿）

- 给**代表图**写 `score`（单张或批量），后端在同一次写入里把该分数**无条件镜像**给它的
  全部成员（`canonical_post_id = 代表图id`），去掉原有的 `AND score = 0` 守卫。
- **`score = 0` 同样下传**：清除代表图评分 = 整组一起清零（完全镜像）。
- 直接给**成员**打分（UI 一般不暴露此入口）只改它自己——成员不指向成员，无兄弟级联，
  与现状一致。
- **`rating` 不级联**，维持现有行为与测试。

### 关键决策与取舍

1. **是否覆盖已评分成员**：覆盖。用户要求"已评分的成员也希望同步"，所以成员各自先前的
   独立分数会被代表图的分覆盖。语义简单一致："成员 = 代表图分数"恒成立。
2. **清零是否下传**：下传（完全镜像）。把代表图设为 0 会把整组成员一并清零，而不是只在
   "镜像"概念里特判正分。实现上无条件级联，最简单。
3. **撤销（undo）粒度**：尽力而为。撤销只把代表图改回旧分；由于后端"每次写分都镜像全组"，
   现有 `revert` 调用 `writeScore` 时会自动把旧分重新镜像给全组——成员因此回到旧分，
   但**不单独保留**它们被覆盖前各自的原始分数。前端撤销逻辑无需改动。

## 后端改动

唯一逻辑改动在 `server/src/db/repositories/posts.py`，纯写侧 SQL：

- `update_field`（单张）：级联 UPDATE 去掉 `AND score = 0`：
  ```sql
  UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP
  WHERE canonical_post_id = ?
  ```
  并更新上方注释（不再是"seed 未评分成员"，而是"镜像给全组成员"）。

- `bulk_update_field`（批量）：级联 UPDATE 去掉 `AND score = 0`：
  ```sql
  UPDATE posts SET score = ?, updated_at = CURRENT_TIMESTAMP
  WHERE canonical_post_id IN (...)
  ```
  并更新注释。

不新增 migration，不改 `entities.py` / `filters.py` / API 控制器 / `scheme.py`；API 签名不变，
**无需 `genapi`**。

## 前端改动

`web/src/shared/mutations.ts` 的 `writeScore`：写入成功后，对每个被评分的 id 额外调用
`qc.invalidateQueries(queryKeys.postGroup(id))`，让已展开的"同组成员"面板即时反映同步后的分数
（成员通过 `postGroup` 查询拿到 `PostSimplePublic`，其中含 `score`）。

撤销逻辑（`commitScore` / `revertGrouped`）**不改**：revert 仍走 `writeScore`，后端会把旧分
重新镜像给全组（尽力而为，见上）。

## 测试

`server/tests/test_post_grouping.py` 的 `TestScorePropagation`：

- 改写 `test_score_seeds_unset_members_keeps_set_ones` → 断言已评分成员（如 p3 先有 5）被
  覆盖成代表图的新分（更名如 `test_score_mirrors_to_all_members`）。
- 新增 `test_score_zero_clears_group`：成员先有非零分，把代表图设为 0 → 成员归 0。
- 批量测试 `test_bulk_score_propagates_per_canonical` 补一个已评分成员，断言同被覆盖。
- 保留 `test_non_score_field_does_not_propagate`（`rating` 不级联）。

跑 `uv run pytest` 与 `uv run ruff check src` 验证。

## 附加功能：按更新时间（updated_at）排序

### 背景

评分会刷新被评分 post 的 `updated_at`（`update_field` / `bulk_update_field` 都设
`updated_at = CURRENT_TIMESTAMP`，级联给成员时也设），但 `updated_at` 目前不在排序白名单里。
本次顺带把它加为一个可选排序列，便于把"最近改动过 / 最近评分过"的图排到前面。

### 决策

- **用 `updated_at`，不新增 `scored_at`**：`updated_at` 反映**任意修改**（评分、改标签、
  描述、来源、旋转、设代表图、danbooru 重新同步等），不是严格的"最近评分"，但复用现有列、
  零额外维护。用户已确认接受这一取舍。
- **加索引**：与 `last_accessed_at`（"最近浏览"视图，migration 0003 已建索引）一致，给约
  17 万行的时间排序建索引，避免每页排序全表扫。

### 后端改动

- 新 migration `server/migrations/0010_index_updated_at.sql`：
  ```sql
  CREATE INDEX ix_posts_updated_at ON posts(updated_at);
  ```
  （单列索引即可，SQLite 可正反向扫，asc/desc 都用得上。）
- `server/src/db/filters.py`：
  - `ORDERABLE_COLUMNS` 加 `"updated_at"`（运行时排序白名单）。
  - `PostFilterWithOrder.order_by` 的 `Literal[...]` 与其 `extra_json_schema` 的 `enum` 各加
    `"updated_at"`（API 校验 + OpenAPI schema，两处都要改）。

### 前端改动

- `web/src/shared/state.ts`：`postSort` 的联合类型加 `'updated_at'`。
- `web/src/components/PostSorter.vue`：`sortOptions` 加一项
  `{ id: 'updated_at', label: 'Updated', icon: 'i-tabler-calendar-event' }`，并扩展其 `id` 联合类型。
- `just web-genapi` 重新生成客户端，使生成的 `order_by` enum 含 `updated_at`（否则
  `order_by: postSort.value` 的赋值会因生成类型不含 `updated_at` 而 TS 报错）。

### 测试

`server/tests/` 既有排序/查询套件中新增：
- `order_by="updated_at"` 能按 `updated_at` 正确排序、且在 `ORDERABLE_COLUMNS` 内被接受。
- 串联两功能的用例：给某 post 评分后，它在 `updated_at desc` 排序里排到最前（评分刷新
  `updated_at`）。

## 不在范围（YAGNI）

- 成员被覆盖前各自原分的精确撤销恢复（已定尽力而为）。
- `rating` 级联（仅 `score` 同步）。
- 成员详情页 `post(memberId)` 的精确失效——客户端无法枚举成员 id；"同组成员"面板的刷新已
  覆盖主要可见场景。
- 专用 `scored_at` 列（已选复用 `updated_at`）；"按更新时间"因此包含非评分类的改动。
