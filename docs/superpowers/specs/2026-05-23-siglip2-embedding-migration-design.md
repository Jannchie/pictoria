# 设计：图片检索 embedding 迁移到 SigLIP 2

- **日期**：2026-05-23
- **状态**：已批准（待写实现计划）
- **作者**：Jianqi Pan + Claude

## 背景与目标

Pictoria 当前的图片检索 embedding 用的是 CLIP ViT-L/14
（`openai/clip-vit-large-patch14`，768 维，cosine），存在 `post_vectors`
这张 `vec0` 虚拟表里（`migrations/0001_initial.sql`）。该 embedding 有两处消费：

1. **以图搜图** `GET /{post_id}/similar`（图 embedding → 图 embedding）
2. **文搜图** `POST /search/text`（用 CLIP **text** encoder 编码 prompt，落到同一向量空间检索 —— `server/src/server/utils/vec.py`）

仓库里已经有 SigLIP，但仅用于**美学打分**（`siglip-so400m-patch14-384`
+ aesthetic-predictor-v2.5，输出标量，是 **SigLIP v1**），与检索 embedding 无关。

本次目标：把检索 embedding 迁移到 **`google/siglip2-so400m-patch14-384`**
（1152 维，多语言文本塔）。

### 动机（按用户优先级）

1. **中文/多语言文搜图**：当前 `/search/text` 只能用英文 prompt；SigLIP 2
   文本塔默认多语言，迁过去即可支持中文检索。
2. **更强的以图搜图**：SigLIP 2 在 retrieval 基准上明显强于 CLIP ViT-L/14。
3. **未来 backbone 对齐**：用户可能训练更多以 SigLIP v2 为 backbone 的模型，
   检索 embedding 与之标准化对齐有价值。

## 选型决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 模型变体 | `google/siglip2-so400m-patch14-384`（1152d） | 检索质量最强、最常用的下游 backbone；与现有美学打分 so400m 谱系一致；12GB 卡 batch=16 可跑（美学打分已验证） |
| 过渡策略 | 并行双表，跑好再切 | 零停机、可 A/B 对比、回滚零成本；临时多占 ~0.7GB 存储 |
| 切换机制 | env 配置开关 `search_embedding_backend` | 仿照现有 `enable_siglip_scorer`；不加并排对比参数，保持简单 |
| VectorRepo | 参数化（加 `table` / `dim`），不复制新类 | 一个 repo 类服务两表，为未来「一模型一 vec0 表」留扩展位 |
| 距离度量 | 仍用 cosine | SigLIP embedding 在 cosine 下检索正常 |

## 架构设计

### 1. 新增 embedding 模块

新建 `server/src/ai/siglip_embed.py`，与 `ai/clip.py` 同构、可平替：

- `get_siglip_embed_model()` / `get_siglip_embed_processor()`：`@cache` 懒加载
  `Siglip2Model` + `AutoProcessor`，`device=cuda`、`bfloat16`（与美学打分器一致）。
- 公共函数：
  - `calculate_image_features_batch(images) -> Tensor (N, 1152)`
  - `calculate_image_features(image) -> Tensor`
  - `calculate_text_features(text) -> Tensor`（多语言，支持中文 prompt）
- 沿用 clip.py 的细节：批量打开/关闭 PIL 文件句柄、transformers 5.x 在
  `get_{image,text}_features` 返回 `BaseModelOutputWithPooling` 时取
  `.pooler_output` 的兜底（按 SigLIP 2 实际返回形状适配）。

**注意**：这是 SigLIP **v2**，与现有美学打分的 SigLIP **v1 so400m** 权重不同，
不能共用，GPU 上是两个独立模型。但 backfill 时 CLIP embedding worker 已无
pending（旧表已填满），不会再加载 CLIP，所以不会三个 backbone 同时挤显存。

### 2. 数据层：新表 + 参数化 VectorRepo

新迁移 `server/migrations/0006_post_vectors_siglip2.sql`：

```sql
CREATE VIRTUAL TABLE post_vectors_siglip2 USING vec0(
    post_id INTEGER PRIMARY KEY,
    embedding FLOAT[1152] distance_metric=cosine
);
```

`server/src/db/repositories/vectors.py` 的 `VectorRepo`：

- 构造参数增加 `table`（默认 `"post_vectors"`）与 `dim`（默认 `768`），
  所有 SQL 用该表名拼接（表名来自代码常量白名单，不来自用户输入）。
- 其余方法（`get`/`upsert`/`delete`/`similar`/`similar_to_post`/
  `list_missing_post_ids`）逻辑不变。
- `list_missing_post_ids` 的 failure-blacklist worker 名按表区分：
  新表用 `embedding:siglip2`，旧表保持 `embedding`。

### 3. Backfill worker

`server/src/processors/__init__.py`：

- 新增 `run_siglip_embedding_worker`，结构同现有 `run_embedding_worker`，
  注入指向新表的 `VectorRepo` + 调 `siglip_embed` 批函数。
- 新增 `_process_siglip_embedding_batch`（仿 `_process_embedding_batch`，
  含 mini-batch / per-image 降级容错）。
- 常量 `SIGLIP_EMBED_BATCH_SIZE = 16`，`gpu_adaptive=True`。
- `run_all_backfill` 中挂上该 worker（分配独立连接，同现有模式）。
- **新上传**：过渡期 `process_post` 同时写两张表（CLIP + SigLIP），保证两边
  完整、切换无缺口。切换并删旧表后再移除 CLIP 那步。

### 4. 检索切换开关

新增配置 `shared.search_embedding_backend ∈ {"clip", "siglip2"}`
（env 开关，仿 `enable_siglip_scorer`），**默认 `clip`**。

- `server/src/server/utils/vec.py` 的 `get_text_vec` / `get_image_vec`
  按 backend 分派到对应编码器。
- `POST /search/text`：`siglip2` 时用 SigLIP 文本塔编码 prompt，查新表。
- `GET /{post_id}/similar`：`siglip2` 时查新表。
- **API 形状不变**，前端无需改动（中文搜索是后端换塔后自动生效）；
  顶多更新搜索框 placeholder 文案。
- backfill 跑到满意后翻 env 为 `siglip2` 完成切换；回滚翻回 `clip`。

### 5. 旧表清理（本次范围外）

旧 `post_vectors` 暂留作回滚后路，确认稳定后用后续迁移
`0007_drop_post_vectors_clip.sql` 删除，并移除 `process_post` 的 CLIP 步骤。

## 测试

- 仿 `server/tests/test_vector_repo.py` 给参数化后的 `VectorRepo`
  （新表名 / 新维度 1152）补充覆盖。
- golden-master 特征测试（`server/tests/`）在改 repo 前后各跑一遍，
  确认旧表行为不回退。
- `siglip_embed` 模块 smoke test：编码一张图 + 一段中文 + 一段英文 prompt，
  断言输出 shape `(1152,)`，且图/文向量在同一空间（cosine 可比）。
- 检查：`uv run ruff check src`、Pyright、`uv run pytest`。

## 明确不做（范围控制）

- 不动 SigLIP v1 美学打分器（用途不同，aesthetic-predictor-v2.5 绑死 v1 权重）。
- 本次不删旧 CLIP 表 / 不删 `ai/clip.py`（切换稳定后再清）。
- 不引入 NaFlex 变体（已选固定分辨率 so400m-patch14-384）。
- 不上完整「多 embedding 空间注册表」（参数化 VectorRepo 已为未来留位，避免过度设计）。

## 验收标准

1. 新表与 backfill worker 上线后，能为全量图片生成 1152d SigLIP 2 embedding。
2. `search_embedding_backend=siglip2` 时，中文 prompt 文搜图返回相关结果。
3. 以图搜图在新 backend 下返回结果，质量主观不劣于 CLIP。
4. 翻回 `clip` 能即时回滚到旧行为。
5. 所有 lint / 类型 / 测试通过，旧 golden-master 不回退。
