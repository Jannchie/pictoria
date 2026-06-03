# 近似重复图片分组（合并）设计

**日期**: 2026-06-03
**作者**: Jianqi Pan
**状态**: 已实现（含修订 1：批处理改用 GPU 分块矩阵乘）

## 背景与目标

图库中存在大量"几乎相同"的图片：

1. **同一张图的不同分辨率/编码**（如 danbooru 的 sample 版 vs original 版、jpg vs png）。
2. **差分变体**（同一构图/角色的细微改动，如表情、姿势、有无遮挡）。

目标：把这类图片**归到一组**，浏览时一组只占一个位置（显示"代表图"，角标标注"另有 X 张"），
而不是散落各处；评分对整组生效；被归入组的"附属图"默认不在搜索/列表/标签 facet 里露面，
只有代表图可被检索和展示。

**硬约束**：用户经常从 danbooru 同步数据，**分组后再次同步不得触发任何重新下载**。

本次范围同时覆盖"同图不同分辨率"和"差分变体"，两者用**同一套机制、同一字段**表达。

## 关键约束：为什么必须用「非销毁式分组」

Danbooru 同步的去重键是 `posts.file_name = str(danbooru_post_id)`（在该标签文件夹 `file_path`
内），见 `services/danbooru_import.py:78-94`：

```python
existing_names = ...  # SELECT file_name FROM posts WHERE file_path = ?
to_persist = [p for p in filtered if str(p.id) not in existing_names]
```

即：**只要某 danbooru id 对应的 post 行还在库里，下次同步就跳过它、不重新下载**。

因此：
- **销毁式合并**（删除重复行只留代表图）会让被删行的 danbooru id 记录消失 → 下次同步认为"没下过" →
  **重新下载**。要避免就得额外维护"已知 danbooru id 黑名单表"，复杂且脆弱。
- **非销毁式分组**（保留所有行 + 一个指针字段标记代表图）天然同时满足两个需求：用户看到合并后的一张，
  但库里每个 danbooru id 都还在，同步逻辑**一行都不用改**。

→ **采用非销毁式分组。** 子表（tags / colors / scores）、向量表、danbooru 导入逻辑全部不动。

## 设计决策

### 1. 数据模型：单字段 `canonical_post_id`

所有关联类型（同分辨率 dup、差分）共用**一个通用字段**：

```sql
-- migration NNNN_add_post_grouping.sql
ALTER TABLE posts ADD COLUMN canonical_post_id INTEGER
    REFERENCES posts(id) ON DELETE SET NULL;   -- NULL=代表图(可见); 非NULL=附属,指向代表图
CREATE INDEX ix_posts_canonical ON posts(canonical_post_id);
```

语义：
- `canonical_post_id IS NULL` → 这张图是**代表图**，正常可搜、进列表。
- `canonical_post_id = C` → 这张图是 C 的**附属**，默认从搜索/列表/facet 隐藏。
- **永远一层、不串链**：代表图自身永远 `NULL`；所有附属直接指向那唯一代表图，不会出现 A→B→C。
- `ON DELETE SET NULL`：手动删掉代表图时，其附属自动升回独立可见，不留孤儿指针。

一组 = `{canonical_post_id = C 的所有图}` ∪ `{C}`；角标"另有 X 张" = 附属数。

同步 Pydantic 实体 `src/db/entities.py` 的 `Post` 增加 `canonical_post_id: int | None`。

### 2. 检测：纯 SigLIP2 单阈值（pHash 留作后手）

复用现成的 SigLIP2 1152 维向量表 `post_vectors_siglip2`（vec0，cosine）与 `VectorRepo` 的 KNN：

- 对每张图用 KNN 取近邻，**cosine 距离 ≤ 阈值** 即判为同组。
- 阈值**可配置**（env/config），边试边调；纳入差分需把阈值放宽，这也是误报风险所在。

**先纯 SigLIP2 试。** 若误报偏多，再单独发 migration 回填 `phash`（64-bit 感知哈希，在 basics
backfill 阶段顺手算），作为"召回后精确验证"的第二级把差分与无关相似图区分开。**本次不实现 phash。**

### 3. 代表图选择：组内最早导入（最小 id）

- 分组时，组内 `id` 最小（最早导入）那张当代表图，其余指向它。
- 实现最简、不需要"出现更高清就换代表"的重指向逻辑。
- **已知代价**：最早导入的未必最高清，可能出现代表图是低清版、高清版被隐藏。用户已确认接受；
  日后可手动"设为代表"调整，或后续增强为按分辨率自动选。

### 4. 分组算法（幂等）

**批处理（建存量 / 调阈值后重建）** —— 按 `id` 升序贪心：

```
for P in posts order by id asc:
    if P.canonical_post_id is not NULL: continue          # 已被认领,不作为新组种子
    # P 是一个代表图(种子)
    for N in KNN(P) where distance <= 阈值 and N.id > P.id and N.canonical_post_id is NULL:
        set N.canonical_post_id = P.id                     # 划入 P 这组
```

- 确定性：代表图永远是相似簇里最早导入的那张。
- 一层无链：被认领的图不再作为种子去认领别人。
- 幂等：调完阈值重跑即可（重建前先把受影响范围 reset 为 NULL，或全表 reset 再重建）。

**增量（新图 embedding 算完后顺手跑）**：

```
取新图 P_new 的 KNN 近邻(distance <= 阈值)
若有近邻: 解析最近近邻 → 它自己(若为代表)或它的代表 → P_new.canonical_post_id = 该代表 id
若无近邻: P_new 保持 NULL(自成新代表)
```

新图永远 id 最大，故附属总挂到更早的代表上，"最早=代表"语义保持。

触发点：① 一次性命令 `/v2/cmd/group-duplicates`（对存量约 17 万图建组、调阈值后重建，幂等）；
② 增量挂在 embedding backfill 完成之后。命令风格对齐现有 `src/server/commands.py` 的 `/v2/cmd/*`。

> **修订 1（实现期）：批处理改用 GPU 分块矩阵乘，而非逐张 KNN。**
> 实测单次 vec0 KNN(`MATCH k=N`)在 5 万行 ≈ 297ms、外推到 17 万行 ≈ 1s/次；逐张 KNN 给存量
> 17 万图建组 ≈ **48 小时,不可行**(CPU 全量两两 BLAS 也要数十小时)。因此 `services/dedup.py`
> 的 `rebuild_groups` 改为:`VectorRepo.load_all()` 把全部 embedding 读入内存矩阵 →
> `torch` 分块 `X @ Xᵀ`(CUDA fp16,无则 CPU fp32)一次性算出所有"余弦相似度 ≥ 1−阈值"的近邻对
> → 同样的"按 id 升序贪心、最早=代表、一层无链"装配。精确、不引入需常驻同步的 ANN 索引。
> **增量路径仍用单次 KNN**(`assign_group_for_post`),因为一次同步只新增几张图,几次 KNN 即可。
>
> **自动触发(全自动)**:不再单独在 embedding worker 里逐张分组(冷启动会退化成 17 万次 KNN),
> 而是在 `processors.run_all_backfill` 跑完后,**若本轮 embedding worker 确有新增**(它现在返回处理数),
> 才调用一次 `rebuild_groups`(GPU 一次 matmul,幂等)。这样:首次冷启动自动给存量建组;每次同步带来
> 新图后自动重建;空闲轮无新增则跳过、零浪费。`/v2/cmd/group-duplicates` 仍保留供手动调阈值重建。
>
> 默认阈值取 `DEFAULT_DEDUP_THRESHOLD = 0.01`(余弦相似度 ≥ 0.99,偏严,主打"同图不同分辨率/编码";
> 想纳入更松的差分就调大),作为 query 参数可逐次覆盖。

### 5. 读取侧：只有代表图露面

**全局默认过滤**：`db/filters.py` 的 `PostFilter` 增加默认开启的 `only_canonical`，
`build_where()` 注入 `AND canonical_post_id IS NULL`。作用于：

- 主列表、文件夹视图、Recently；
- 文搜图、图搜图（KNN 已有过滤时 oversample 到 1000 的机制，过滤附属后仍够数）。

**展开某组**走单独路径：`WHERE canonical_post_id = :id` 取全部成员。

**tag facet 计数处理**（本功能唯一稍费 SQL 处）：`tags.post_count` 由 migration 0008 的
AFTER INSERT/DELETE 触发器按全部 `post_has_tag` 行维护；附属图仍保留自己的 tag 行 → 计数偏高。

采用方案：扩展该套触发器，使 `post_count` 只统计**代表图**：
- INSERT/DELETE 触发器加守卫：仅当 `(SELECT canonical_post_id FROM posts WHERE id = NEW.post_id) IS NULL` 时才增减；
- 新增 `AFTER UPDATE OF canonical_post_id ON posts` 触发器：图被归组（NULL→非NULL）时按其 tag 递减、
  移出组（非NULL→NULL）时递增。

这样 `post_count` 恒等于"可见(代表)图中含该 tag 的数量"。
（更省的 v1 备选：先不动触发器、接受计数略偏高，以后再补——已记录，默认走上面的正确方案。）

### 6. UI/UX

- **画廊**：代表图卡片右下角小角标 `+X`（X=附属数），可加轻微堆叠样式暗示"这是一组"。
- **代表图详情页**：新增"同组 (X+1)"横条，列出全部成员（各自分辨率/文件大小），可查看/下载特定分辨率那张；
  每个成员可"设为代表"（手动改指向）或"移出组"（`canonical_post_id` 置 NULL）。
- 直接用 id/URL 访问某附属图时，顶部提示"此图属于〔代表图〕的一组"并给链接。
- 评分 / rating 打在代表图上即代表整组（附属图本就不露面）。

### 7. Danbooru 同步交互

`services/danbooru_import.py` **一行不改**。所有行（含附属）的 `file_name=str(danbooru_id)` 都还在库里，
去重 `to_persist` 照常短路 → 不重新下载。检测在 embedding backfill 之后跑，幂等。

### 8. 可逆性与边界

- **手动**：移出组（`canonical_post_id`=NULL）、改设代表图，随时可逆。
- **删除代表图**：`ON DELETE SET NULL` 使其附属升回独立可见（散回画廊）。
- **配置**：相似阈值经 env/config 暴露；重建命令幂等，调阈值后重跑即可。

### 已知 v1 局限（均记录、后续可增强）

1. 纯 SigLIP2 阈值放宽以纳入差分会有**误报风险**（把无关相似图归到一起）；缓解后手是回填 phash 做二级验证。
2. 新图同时贴近两个已有组时**只挂最近的那个、不合并两组**。
3. 只搜代表图，因此某差分**独有的 tag** 不会让该组在标签搜索里出现（同分辨率 dup 的 tag 通常一致，无此问题）。
4. 代表图为"最早导入"，可能不是最高清。

## 改动清单

- **migration**：新增 `NNNN_add_post_grouping.sql`（加列 + 索引）；扩展 tag `post_count` 触发器
  （守卫 + `AFTER UPDATE OF canonical_post_id`），可同文件或紧随其后的编号文件。
- **`src/db/entities.py`**：`Post` 加 `canonical_post_id: int | None`。
- **`src/db/filters.py`**：`PostFilter` 加 `only_canonical`（默认 True），`build_where()` 注入过滤。
- **`src/db/repositories/`**：写侧分组方法（设/清 `canonical_post_id`、批量重建）放到 `PostRepo`。
- **`src/db/queries/`**：`PostQueryService` 的列表/搜索默认带 `only_canonical`；新增"取某组成员"读法；
  facet 计数读 `post_count` 即可（已由触发器保证只计代表图）。
- **检测逻辑**：新模块（如 `src/services/dedup.py`）实现 KNN+贪心分组，复用 `VectorRepo`。
- **`src/server/commands.py`**：`/v2/cmd/group-duplicates` 命令；embedding backfill 完成后调用增量分组。
- **前端**：画廊角标/堆叠样式；代表图详情页"同组"横条 + 设为代表/移出组操作；附属图访问提示。
- **API 客户端**：`just web-genapi` 重新生成。

## 测试

沿用 `server/tests/` golden-master 套路，新增：

- 分组分配**确定性**（同输入同结果，代表图=最小 id）；
- 读取侧过滤**确实排除附属**（列表/文搜图/图搜图）；
- tag facet **计数正确**（含归组、移出组、删代表图后的增减）；
- `ON DELETE SET NULL` 行为（删代表图后附属升回可见）；
- 批处理**重跑幂等**。

## 不在本次范围（YAGNI / 后续）

- phash 二级验证（仅在纯 SigLIP2 误报多时才回填）。
- "出现更高清自动换代表"。
- 跨组合并（新图桥接两组时合并）。
- 把附属的独有 tag 并入代表图（让标签搜索能搜到组）。
- 差分"仍可见、仅关联"的双关系语义（本次统一为隐藏在代表图后）。
