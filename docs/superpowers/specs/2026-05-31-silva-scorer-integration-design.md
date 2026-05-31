# SILVA 美学打分器接入设计

**日期**: 2026-05-31
**作者**: Jianqi Pan
**状态**: 已批准设计，待实现

## 背景与目标

为 Pictoria 接入第三个美学打分器 `silva`（SILVA: SigLIP-based Illustration
Visual Aesthetic Scorer，PyPI 包 `silva-scorer>=0.1.1`，作者自有模型
`Jannchie/silva-aesthetic`）。目标：对图库中的图片用 silva 打分、持久化分数，
并支持前端按 silva 分数排序。

打分器接入完全镜像现有的 `siglip-v2-5`（`ai/siglip_scorer.py` +
`post_aesthetic_scores` 通用表）的既有路径，复用现成的批处理、降级、失败黑名单
基础设施，保持架构一致。

## silva 包 API（已确认）

```python
from silva import AestheticScorer

scorer = AestheticScorer.from_pretrained("Jannchie/silva-aesthetic", device="cuda")
scorer.score("a.png")             # -> float，单图
scorer.score(["a.png", "b.png"])  # -> list[float]，批量
```

- 分数区间 **[0, 1]**（注意：waifu / siglip 是 ~0–10，silva 小一个量级）。
- backbone 是 SigLIP2（`silva.backbone.Embedder`），首次 `score` 时懒加载，
  模型权重从 Hugging Face Hub 下载，首跑需联网。
- `score` 接受 `str | PathLike | PIL.Image`，单图返回 `float`、list/tuple
  返回 `list[float]`。

## 设计决策

- **方案 A：复用通用表 `post_aesthetic_scores`，不新增数据库列。**
  silva 分数以 `scorer = "silva"` 存入该表，与 `siglip-v2-5` 同表。前端
  `PostPublic.aesthetic_scores: list[AestheticScorePublic]` 会自动透出 silva
  分数，无需改 `scheme.py`。
- **opt-in 开关**：与 `siglip` 一致，默认关闭，需 `ENABLE_SILVA_SCORER=1`
  才挂 backfill worker / 单图打分，避免默认占用 GPU。
- **支持按 silva 分排序**：新增虚拟排序列 `silva_score`，与 `siglip_score`
  同构，按需 JOIN 表、`NULLS LAST` 让未打分的图沉底。
- **分数区间差异不特殊处理**：通用表只存原始 `float`，前端展示与排序都用原始
  值。silva 不进入 waifu 专用的分数直方图统计（YAGNI）。

## 改动清单

### 后端

1. **新建 `src/ai/silva_scorer.py`** — 镜像 `ai/siglip_scorer.py`：
   - `SCORER_NAME = "silva"`
   - `score_images(inputs: Sequence[ImageInput]) -> list[float]`，始终返回 list
     （即使单元素，配合 `_score_batch_with_fallback` 的 `scorer_fn([path])`
     单图降级调用）
   - `@cache` 懒加载 `AestheticScorer.from_pretrained("Jannchie/silva-aesthetic",
     device=str(DEVICE))`，复用 `ai.torch_runtime.DEVICE`
   - 输入 RGB 归一与 siglip_scorer 一致用 `to_rgb`，避免非 RGB 图（如 P/LA 模式）
     在 backbone 处出错

2. **`src/shared.py`** — 新增 `enable_silva_scorer = False`（紧邻
   `enable_siglip_scorer`，附同风格注释）。

3. **`src/utils.py`** — 读取 `ENABLE_SILVA_SCORER` 环境变量写入
   `shared.enable_silva_scorer`（镜像 `ENABLE_SIGLIP_SCORER` 那段，含 info 日志）。

4. **`src/processors/__init__.py`** — 镜像 siglip worker：
   - 新增 `SILVA_BATCH_SIZE = 16`
   - `run_silva_worker`（镜像 `run_siglip_worker`，进度条名 "SILVA scorer"，
     `gpu_adaptive=True`，用 `_list_aesthetic_pending(posts, SCORER_NAME)`）
   - `_process_silva_batch`（镜像 `_process_siglip_batch`，失败黑名单 worker 名
     `aesthetic:silva`，`upsert_aesthetic_score(pid, "silva", score)`）
   - `run_all_backfill`：`silva_conn = _checkout() if shared.enable_silva_scorer
     else None`，opt-in 时 append `run_silva_worker`
   - `process_post`：`if shared.enable_silva_scorer: await
     _process_silva_batch(posts, [post.id])`

5. **`src/db/filters.py`** — `PostFilterWithOrder.order_by` 的 `Literal[...]` 与
   `extra_json_schema` 的 `enum` 各追加 `"silva_score"`；`ORDERABLE_COLUMNS`
   追加 `"silva_score"`。

6. **`src/db/queries/post_query.py`** — 在 score-based 排序分支加
   `elif f.order_by == "silva_score":`，LEFT JOIN
   `post_aesthetic_scores pas_silva ON pas_silva.post_id = p.id AND
   pas_silva.scorer = 'silva'`，`ORDER BY pas_silva.score {direction} NULLS LAST`
   （镜像 `siglip_score` 分支）。

### 前端

7. **`just web-genapi`** — 重新生成 `web/src/api/types.gen.ts`（`order_by` 枚举
   自动带上 `silva_score`）。

8. 手写的 `order_by` 联合类型三处 + 排序下拉补 `silva_score`：
   - `web/src/components/PostSorter.vue`：联合类型 + 选项
     `{ id: 'silva_score', label: 'SILVA score', icon: 'i-tabler-sparkles' }`
     （icon 可与 siglip 区分，实现时定）
   - `web/src/shared/queries.ts`：联合类型
   - `web/src/shared/state.ts`：`postSort` 联合类型

### 测试

9. 在 `server/tests/` 加一条 `silva_score` 排序的特征测试：插入若干带/不带
   silva 分数的 post，断言 `order_by=silva_score` 时已打分的按分数序、未打分的
   因 `NULLS LAST` 沉底。

10. 跑现有 golden-master 套件（`uv run pytest`）确认无回归；
    `uv run ruff check src` 通过。

## 不做的事（YAGNI）

- 不在 `posts` 表加专用列（方案 B）。
- 不让 silva 与 siglip 共享 backbone（方案 C，未来优化）。
- 不加 silva 专用的分数直方图统计 / 区间筛选（siglip 也只有排序，无直方图）。
- 不做分数归一化到 0–10（前端展示原始 [0,1] 值即可）。

## 风险

- silva 首跑需从 HF Hub 下载 `Jannchie/silva-aesthetic` 权重 —— 需联网；
  与现有所有模型加载行为一致。
- silva 与 siglip-embedding、siglip-scorer 同为 SigLIP 系 backbone，开启后
  GPU 显存压力增加 —— 已由 opt-in 默认关闭 + `gpu_adaptive` 自适应批大小缓解。
