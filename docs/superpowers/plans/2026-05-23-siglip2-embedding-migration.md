# SigLIP 2 Embedding Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把图片检索 embedding 从 CLIP ViT-L/14（768d）迁移到 `google/siglip2-so400m-patch14-384`（1152d，多语言文本塔），采用并行双表过渡，由 env 开关切换。

**Architecture:** 新建 `post_vectors_siglip2`（FLOAT[1152]）vec0 表与旧 `post_vectors` 并存；`VectorRepo` 参数化以同时服务两表；新增 `ai/siglip_embed.py` 做 SigLIP 2 前向；新增 backfill worker 填充新表；`shared.search_embedding_backend`（env `SEARCH_EMBEDDING_BACKEND`）控制检索端用哪套编码器+表，默认 `clip`，跑满后翻 `siglip2`。

**Tech Stack:** Python 3.12 / Litestar / 嵌入式 SQLite + sqlite-vec（vec0）/ transformers（`Siglip2Model`）/ torch（CUDA, bfloat16）/ pytest。

参考 spec：`docs/superpowers/specs/2026-05-23-siglip2-embedding-migration-design.md`

> **代码注释约定**：本仓库 ruff `select=["ALL"]` 只 ignore 了 RUF003，未 ignore
> RUF001/RUF002，且现有 `.py` 全用英文注释。**因此实现时所有 Python 注释/docstring
> 一律写英文**（下方代码块里的中文注释仅为计划可读性，落地时译成英文）。计划/spec
> markdown 文档本身不受此约束。

---

## File Structure

- **Create** `server/migrations/0006_post_vectors_siglip2.sql` — 新 vec0 表 FLOAT[1152]。
- **Modify** `server/src/db/repositories/vectors.py` — `VectorRepo` 加 `table` / `dim` 参数 + 表名白名单 + upsert 维度校验。
- **Create** `server/src/ai/siglip_embed.py` — SigLIP 2 图/文特征前向（与 `ai/clip.py` 同构）。
- **Modify** `server/src/shared.py` — 新增 `search_embedding_backend` 标志。
- **Modify** `server/src/utils.py` — `prepare_feature_flags` 读取 `SEARCH_EMBEDDING_BACKEND`。
- **Modify** `server/src/server/utils/vec.py` — `get_text_vec` / `get_image_vec` 按 backend 分派编码器。
- **Modify** `server/src/app.py` — `provide_vector_repo` 按 backend 选表。
- **Modify** `server/src/processors/__init__.py` — 新 worker + 批处理器 + 接入 `run_all_backfill` + `process_post` 双写。
- **Modify** `server/tests/test_vector_repo.py` — 参数化新表覆盖。
- **Create** `server/tests/test_siglip_embed.py` — 模块结构 + 可选 GPU smoke test。
- **Create** `server/tests/test_feature_flags.py` — env → flag 解析。
- **Create** `server/tests/test_vec_dispatch.py` — vec helper 按 backend 分派。

---

## Task 1: 新增 SigLIP 2 vec0 表迁移

**Files:**
- Create: `server/migrations/0006_post_vectors_siglip2.sql`
- Test: `server/tests/test_vector_repo.py`（沿用 conftest 的 `db` 夹具自动跑迁移）

- [ ] **Step 1: 写迁移文件**

Create `server/migrations/0006_post_vectors_siglip2.sql`:

```sql
-- post_vectors_siglip2: SigLIP 2 图片 embedding，1152 维，cosine。
--
-- 与旧 post_vectors（CLIP ViT-L/14, FLOAT[768]）并行存在，用于检索 backend
-- 从 CLIP 迁移到 SigLIP 2 的零停机过渡：backfill 期间旧表继续服务检索，
-- 待新表填满后由 shared.search_embedding_backend 切换。两张表都是 vec0
-- 虚拟表，post_id 作为 rowid，不参与 FK cascade（删除 post 时需在
-- PostRepo.delete_many 中显式清理，与旧表一致）。
CREATE VIRTUAL TABLE post_vectors_siglip2 USING vec0(
    post_id INTEGER PRIMARY KEY,
    embedding FLOAT[1152] distance_metric=cosine
);
```

- [ ] **Step 2: 写测试——迁移后表存在且维度正确**

在 `server/tests/test_vector_repo.py` 末尾追加：

```python
class TestSiglip2TableMigration:
    async def test_table_exists(self, db: DB) -> None:
        cur = db.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE name = 'post_vectors_siglip2'",
        )
        assert cur.fetchone() is not None

    async def test_rejects_wrong_dim_blob(self, db: DB) -> None:
        # vec0 enforces the declared dimension; a 768-float blob must fail.
        import sqlite_vec

        cur = db.cursor()
        blob = sqlite_vec.serialize_float32([0.0] * 768)
        with pytest.raises(Exception):  # noqa: B017  # sqlite OperationalError
            cur.execute(
                "INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (1, ?)",
                [blob],
            )
```

- [ ] **Step 3: 跑测试，确认通过**

Run: `cd server && uv run pytest tests/test_vector_repo.py::TestSiglip2TableMigration -v`
Expected: 2 passed（迁移由 `db` 夹具的 `run_migrations` 自动应用）。

- [ ] **Step 4: Commit**

```bash
git add server/migrations/0006_post_vectors_siglip2.sql server/tests/test_vector_repo.py
git commit -m "feat(db): add post_vectors_siglip2 vec0 table (1152d)"
```

> **注**：`PostRepo.delete_many` 需要同时清理新表（vec0 不参与 FK cascade），
> 但其测试依赖 Task 2 的参数化 `VectorRepo`，故该修复并入 Task 2。

---

## Task 2: 参数化 VectorRepo（table + dim）+ delete_many 清理新表

**Files:**
- Modify: `server/src/db/repositories/vectors.py`
- Modify: `server/src/db/repositories/posts.py:160-183`（`delete_many`）
- Test: `server/tests/test_vector_repo.py`

- [ ] **Step 1: 写失败测试——VectorRepo 可指向 siglip2 表并 roundtrip 1152d 向量**

在 `server/tests/test_vector_repo.py` 顶部 `_unit_vec` 已支持 `dim` 参数。追加一个夹具与测试类：

```python
@pytest.fixture
def siglip_repo(db: DB) -> VectorRepo:
    return VectorRepo(db.cursor(), table="post_vectors_siglip2", dim=1152)


class TestParameterizedTable:
    async def test_siglip_table_roundtrip(self, siglip_repo: VectorRepo) -> None:
        vec = _unit_vec(0, dim=1152)
        await siglip_repo.upsert(1, vec)
        got = await siglip_repo.get(1)
        assert got is not None
        assert len(got) == 1152
        assert got[0] == pytest.approx(1.0)

    async def test_two_repos_are_isolated(
        self, vec_repo: VectorRepo, siglip_repo: VectorRepo,
    ) -> None:
        # Writing to the CLIP table must not appear in the SigLIP table.
        await vec_repo.upsert(7, _unit_vec(0, dim=768))
        assert await siglip_repo.get(7) is None

    async def test_upsert_rejects_wrong_dim(self, siglip_repo: VectorRepo) -> None:
        with pytest.raises(ValueError, match="expected dim 1152"):
            await siglip_repo.upsert(1, _unit_vec(0, dim=768))

    async def test_rejects_unknown_table(self, db: DB) -> None:
        with pytest.raises(ValueError, match="unknown vector table"):
            VectorRepo(db.cursor(), table="post_vectors_evil")
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd server && uv run pytest tests/test_vector_repo.py::TestParameterizedTable -v`
Expected: FAIL —`VectorRepo.__init__` 还不接受 `table` / `dim`（TypeError）。

- [ ] **Step 3: 实现参数化**

Modify `server/src/db/repositories/vectors.py`。把模块常量与 `__init__` 改成：

```python
EMBED_DIM = 768

# 表名只能来自这份代码常量白名单 —— 它会被拼进 SQL 字符串（参数占位符
# 不能用于标识符），所以必须封死，杜绝任何外部输入流入表名。
_ALLOWED_TABLES: dict[str, int] = {
    "post_vectors": 768,
    "post_vectors_siglip2": 1152,
}
```

把 `class VectorRepo` 的 `__init__` 替换为：

```python
    def __init__(
        self,
        cur: sqlite3.Cursor,
        *,
        table: str = "post_vectors",
        dim: int | None = None,
    ) -> None:
        if table not in _ALLOWED_TABLES:
            msg = f"unknown vector table: {table!r}"
            raise ValueError(msg)
        self.cur = cur
        self.table = table
        self.dim = dim if dim is not None else _ALLOWED_TABLES[table]
```

把所有方法里写死的 `post_vectors` 表名换成 `self.table`（用 f-string 拼接，表名来自白名单常量）。逐处：

`get`:

```python
            self.cur.execute(
                f"SELECT embedding FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
```

`upsert` —— 在序列化前加维度校验，并把两条 SQL 的表名参数化：

```python
    async def upsert(self, post_id: int, embedding: np.ndarray | list[float]) -> None:
        emb = embedding if isinstance(embedding, list) else embedding.tolist()
        if len(emb) != self.dim:
            msg = f"{self.table}: expected dim {self.dim}, got {len(emb)}"
            raise ValueError(msg)
        blob = sqlite_vec.serialize_float32(emb)

        def _impl() -> None:
            self.cur.execute(
                f"DELETE FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
            self.cur.execute(
                f"INSERT INTO {self.table}(post_id, embedding) VALUES (?, ?)",  # noqa: S608
                [post_id, blob],
            )

        await asyncio.to_thread(_impl)
```

`delete`:

```python
            self.cur.execute(
                f"DELETE FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
```

`similar` 的 SELECT：

```python
            self.cur.execute(
                f"""
                SELECT post_id, distance
                FROM {self.table}
                WHERE embedding MATCH ? AND k = ?
                ORDER BY distance
                """,  # noqa: S608
                [blob, fetch_limit],
            )
```

`similar` 里序列化前也加同样的维度校验：

```python
        emb = embedding if isinstance(embedding, list) else embedding.tolist()
        if len(emb) != self.dim:
            msg = f"{self.table}: expected dim {self.dim}, got {len(emb)}"
            raise ValueError(msg)
        blob = sqlite_vec.serialize_float32(emb)
```

`similar_to_post` 的两条 SQL（存在性检查 + MATCH 子查询）：

```python
            self.cur.execute(
                f"SELECT 1 FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
            if self.cur.fetchone() is None:
                return []
            self.cur.execute(
                f"""
                SELECT post_id, distance
                FROM {self.table}
                WHERE embedding MATCH (
                    SELECT embedding FROM {self.table} WHERE post_id = ?
                ) AND k = ?
                ORDER BY distance
                """,  # noqa: S608
                [post_id, fetch_limit],
            )
```

`list_missing_post_ids` 的两条 JOIN SQL（把 `post_vectors` / 别名 `pv` 换成 `self.table`，worker 黑名单名也参数化）—— 替换整个方法体的 SQL 拼接为：

```python
    async def list_missing_post_ids(
        self,
        *,
        image_exts: list[str] | None = None,
        worker: str = "embedding",
    ) -> list[int]:
        def _impl() -> list[int]:
            blacklist_clause = (
                "AND NOT EXISTS ("
                "SELECT 1 FROM post_process_failures f "
                "WHERE f.post_id = p.id AND f.worker = ?)"
            )
            if image_exts:
                placeholders = ",".join("?" * len(image_exts))
                ext_clause = f"AND LOWER(p.extension) IN ({placeholders})"
                self.cur.execute(
                    f"SELECT p.id FROM posts p "  # noqa: S608
                    f"LEFT JOIN {self.table} pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL "
                    + ext_clause + " " + blacklist_clause
                    + " ORDER BY p.id",
                    [*image_exts, worker],
                )
            else:
                self.cur.execute(
                    f"SELECT p.id FROM posts p "  # noqa: S608
                    f"LEFT JOIN {self.table} pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL " + blacklist_clause
                    + " ORDER BY p.id",
                    [worker],
                )
            return [r[0] for r in self.cur.fetchall()]

        return await asyncio.to_thread(_impl)
```

> 注意：原 `list_missing_post_ids` 把 worker 名 `'embedding'` 写死在 SQL 字符串里；这里改成参数 `worker`（默认 `"embedding"`，保持旧行为），新表 worker 传 `"embedding:siglip2"`。

- [ ] **Step 3b: delete_many 同时清理新表 + 测试**

Modify `server/src/db/repositories/posts.py` 的 `delete_many._impl`，在
`DELETE FROM post_vectors ...` 之后追加对新表的 DELETE：

```python
            self.cur.execute(
                f"DELETE FROM post_vectors_siglip2 WHERE post_id IN ({placeholders})",  # noqa: S608
                ids,
            )
```

并把该方法 docstring 中 “``post_vectors`` is a vec0 virtual table and doesn't
participate in foreign-key cascades — clear it explicitly.” 改为
“``post_vectors`` / ``post_vectors_siglip2`` are vec0 virtual tables and don't
participate in foreign-key cascades — clear them explicitly.”

测试（append 到 `server/tests/test_vector_repo.py`）：

```python
class TestDeleteClearsBothVectorTables:
    async def test_delete_post_clears_both_tables(self, db: DB) -> None:
        from db.repositories.posts import PostRepo

        clip = VectorRepo(db.cursor())
        siglip = VectorRepo(db.cursor(), table="post_vectors_siglip2", dim=1152)
        await clip.upsert(1, _unit_vec(0, dim=768))
        await siglip.upsert(1, _unit_vec(0, dim=1152))

        await PostRepo(db.cursor()).delete_many([1])

        assert await clip.get(1) is None
        assert await siglip.get(1) is None
```

- [ ] **Step 4: 跑新测试，确认通过**

Run: `cd server && uv run pytest tests/test_vector_repo.py -v`
Expected: 全部 PASS（含旧 `TestUpsertAndGet` / `TestSimilar`，证明默认 768 行为不回退）。

- [ ] **Step 5: 跑 golden-master，确认数据层不回退**

Run: `cd server && uv run pytest -q`
Expected: 全绿。

- [ ] **Step 6: Lint**

Run: `cd server && uv run ruff check src/db/repositories/vectors.py`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add server/src/db/repositories/vectors.py server/src/db/repositories/posts.py server/tests/test_vector_repo.py
git commit -m "refactor(db): parameterize VectorRepo by table/dim; clear siglip table on delete"
```

---

## Task 3: 新增 SigLIP 2 embedding 模块

**Files:**
- Create: `server/src/ai/siglip_embed.py`
- Test: `server/tests/test_siglip_embed.py`

> **测试说明**：真正的前向需要下载 ~1.6GB 权重并占用 GPU，CI/无网环境不可用。
> 因此结构测试（导入、公共符号、`EMBED_DIM`）必跑，推理 smoke test 用
> `@pytest.mark.skipif` 在无 CUDA 时跳过。本模块本身镜像 `ai/clip.py`（后者
> 也无单测，靠 worker 集成验证）。

- [ ] **Step 1: 写结构测试（先失败）**

Create `server/tests/test_siglip_embed.py`:

```python
"""SigLIP 2 embedding 模块测试。

结构测试始终运行；推理 smoke test 需要 CUDA + 已下载权重，故 skipif。
"""

from __future__ import annotations

import importlib

import pytest


def test_module_exposes_public_api() -> None:
    mod = importlib.import_module("ai.siglip_embed")
    assert mod.EMBED_DIM == 1152
    for name in (
        "calculate_image_features",
        "calculate_image_features_batch",
        "calculate_text_features",
    ):
        assert callable(getattr(mod, name)), name


@pytest.mark.skipif(
    "not __import__('torch').cuda.is_available()",
    reason="SigLIP 2 forward needs CUDA + downloaded weights",
)
def test_text_features_shape() -> None:
    from ai.siglip_embed import EMBED_DIM, calculate_text_features

    feats = calculate_text_features(["一只猫", "a cat"])
    assert feats.shape == (2, EMBED_DIM)
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd server && uv run pytest tests/test_siglip_embed.py::test_module_exposes_public_api -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ai.siglip_embed'`。

- [ ] **Step 3: 实现模块**

Create `server/src/ai/siglip_embed.py`:

```python
"""SigLIP 2 图/文 embedding 前向（DB-free）。

检索 backend 从 CLIP（``ai.clip``）迁移到 SigLIP 2 时的图/文编码器。结构与
``ai.clip`` 同构、可平替：图特征喂 backfill worker 落到 ``post_vectors_siglip2``，
文特征喂 ``/search/text`` 做多语言文搜图。

Backbone 为 ``google/siglip2-so400m-patch14-384``（1152 维，多语言文本塔），
与美学打分用的 SigLIP **v1** so400m 是不同权重，不能共用，GPU 上各占一份。
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterable, Sequence
from functools import cache
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

MODEL_ID = "google/siglip2-so400m-patch14-384"
EMBED_DIM = 1152

_device = "cuda" if torch.cuda.is_available() else "cpu"
_dtype = torch.bfloat16 if _device == "cuda" else torch.float32


@cache
def get_model() -> AutoModel:
    model = AutoModel.from_pretrained(MODEL_ID, device_map=_device)
    model = model.to(dtype=_dtype)
    model.eval()
    _patch_features_to_tensor(model)
    return model


def _patch_features_to_tensor(model: AutoModel) -> None:
    # transformers 5.x 的 get_{image,text}_features 可能返回
    # BaseModelOutputWithPooling 而非裸投影张量；下游期望张量，统一解包。
    for attr in ("get_image_features", "get_text_features"):
        original = getattr(model, attr, None)
        if original is None:
            continue

        def wrapper(*args: object, _orig: object = original, **kwargs: object) -> object:
            out = _orig(*args, **kwargs)  # type: ignore[operator]
            return getattr(out, "pooler_output", out)

        setattr(model, attr, wrapper)


@cache
def get_processor() -> AutoProcessor:
    return AutoProcessor.from_pretrained(MODEL_ID)


ImageInput = Image.Image | Path | str


def _to_rgb(img: Image.Image) -> Image.Image:
    return img if img.mode == "RGB" else img.convert("RGB")


def calculate_image_features(image: ImageInput) -> torch.Tensor:
    if isinstance(image, Path | str):
        image = Image.open(image)
    image = _to_rgb(image)
    model = get_model()
    processor = get_processor()
    inputs = processor(images=image, return_tensors="pt").to(_device)
    pixel_values = inputs.pixel_values.to(dtype=_dtype)
    with torch.inference_mode():
        return model.get_image_features(pixel_values=pixel_values)


def calculate_image_features_batch(images: Sequence[ImageInput]) -> torch.Tensor:
    """一次 GPU 前向编码一批图，返回 ``(N, 1152)``。"""
    if not images:
        return torch.empty(0, device=_device)
    pil_images = [
        _to_rgb(Image.open(img)) if isinstance(img, Path | str) else _to_rgb(img)
        for img in images
    ]
    try:
        model = get_model()
        processor = get_processor()
        inputs = processor(images=pil_images, return_tensors="pt").to(_device)
        pixel_values = inputs.pixel_values.to(dtype=_dtype)
        with torch.inference_mode():
            return model.get_image_features(pixel_values=pixel_values)
    finally:
        _close_opened(pil_images, images)


def _close_opened(pil_images: list[Image.Image], original: Iterable[ImageInput]) -> None:
    for opened, src in zip(pil_images, original, strict=True):
        if opened is src:
            continue
        with contextlib.suppress(Exception):
            opened.close()


def calculate_text_features(text: str | list[str]) -> torch.Tensor:
    """多语言文本特征（与图特征同空间），返回 ``(N, 1152)``。"""
    if isinstance(text, str):
        text = [text]
    model = get_model()
    processor = get_processor()
    # SigLIP 训练用固定 padding="max_length"；保持与上游推理一致。
    inputs = processor(text=text, return_tensors="pt", padding="max_length").to(_device)
    with torch.inference_mode():
        return model.get_text_features(**inputs)
```

- [ ] **Step 4: 跑结构测试，确认通过**

Run: `cd server && uv run pytest tests/test_siglip_embed.py::test_module_exposes_public_api -v`
Expected: PASS。（GPU smoke test 在无 CUDA 时显示 skipped。）

- [ ] **Step 5: Lint**

Run: `cd server && uv run ruff check src/ai/siglip_embed.py`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add server/src/ai/siglip_embed.py server/tests/test_siglip_embed.py
git commit -m "feat(ai): add SigLIP 2 image/text embedding module"
```

---

## Task 4: 检索 backend 配置开关

**Files:**
- Modify: `server/src/shared.py`
- Modify: `server/src/utils.py:77-84`（`prepare_feature_flags`）
- Test: `server/tests/test_feature_flags.py`

- [ ] **Step 1: 写失败测试**

Create `server/tests/test_feature_flags.py`:

```python
from __future__ import annotations

import importlib

import pytest


@pytest.fixture(autouse=True)
def _restore_flag():
    import shared
    original = shared.search_embedding_backend
    yield
    shared.search_embedding_backend = original


@pytest.mark.parametrize(
    ("env_value", "expected"),
    [
        (None, "clip"),
        ("", "clip"),
        ("clip", "clip"),
        ("siglip2", "siglip2"),
        ("SIGLIP2", "siglip2"),
        ("garbage", "clip"),  # 无法识别 → 安全回退到 clip
    ],
)
def test_backend_flag_parsing(
    monkeypatch: pytest.MonkeyPatch, env_value: str | None, expected: str,
) -> None:
    import shared
    import utils

    if env_value is None:
        monkeypatch.delenv("SEARCH_EMBEDDING_BACKEND", raising=False)
    else:
        monkeypatch.setenv("SEARCH_EMBEDDING_BACKEND", env_value)
    utils.prepare_feature_flags()
    assert shared.search_embedding_backend == expected
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd server && uv run pytest tests/test_feature_flags.py -v`
Expected: FAIL — `shared` 还没有 `search_embedding_backend` 属性（AttributeError）。

- [ ] **Step 3: 在 shared.py 增加标志**

在 `server/src/shared.py` 末尾（`enable_siglip_scorer = False` 之后）追加：

```python
# 检索（以图搜图 / 文搜图）使用哪套 embedding：
#   "clip"    —— 旧 CLIP ViT-L/14，post_vectors（768d）。默认。
#   "siglip2" —— SigLIP 2 so400m，post_vectors_siglip2（1152d，多语言文搜图）。
# 由 env ``SEARCH_EMBEDDING_BACKEND`` 设置（utils.prepare_feature_flags）。
# 迁移期保持 "clip"，待 post_vectors_siglip2 backfill 跑满后翻 "siglip2"。
search_embedding_backend: str = "clip"
```

- [ ] **Step 4: 在 utils.prepare_feature_flags 读取 env**

Modify `server/src/utils.py`，在 `prepare_feature_flags` 内 `enable_siglip_scorer` 那段之后追加：

```python
    backend = os.environ.get("SEARCH_EMBEDDING_BACKEND", "").strip().lower()
    if backend in ("clip", "siglip2"):
        shared.search_embedding_backend = backend
    elif backend:
        logger.warning(
            f"SEARCH_EMBEDDING_BACKEND={backend!r} not recognised; "
            "falling back to 'clip'",
        )
        shared.search_embedding_backend = "clip"
    logger.info(f"search_embedding_backend = {shared.search_embedding_backend}")
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `cd server && uv run pytest tests/test_feature_flags.py -v`
Expected: 6 passed。

- [ ] **Step 6: Lint + Commit**

```bash
cd server && uv run ruff check src/shared.py src/utils.py
git add server/src/shared.py server/src/utils.py server/tests/test_feature_flags.py
git commit -m "feat(config): add SEARCH_EMBEDDING_BACKEND switch (clip|siglip2)"
```

---

## Task 5: vec helper 按 backend 分派编码器

**Files:**
- Modify: `server/src/server/utils/vec.py`
- Test: `server/tests/test_vec_dispatch.py`

- [ ] **Step 1: 写失败测试（monkeypatch 掉两套编码器，断言分派正确）**

Create `server/tests/test_vec_dispatch.py`:

```python
from __future__ import annotations

import sys
import types

import numpy as np
import pytest


@pytest.fixture
def fake_encoders(monkeypatch: pytest.MonkeyPatch):
    """注入假的 ai.clip / ai.siglip_embed，避免加载真实 ML 栈。

    每个假编码器返回一个 (1, dim) 的常量张量替身（用 numpy 即可，
    因为 get_text_vec 只调用 .cpu().numpy()[0]）。
    """

    class _FakeTensor:
        def __init__(self, arr: np.ndarray) -> None:
            self._arr = arr

        def cpu(self) -> "_FakeTensor":
            return self

        def numpy(self) -> np.ndarray:
            return self._arr

    def make_module(dim: int) -> types.ModuleType:
        mod = types.ModuleType("fake")
        mod.calculate_text_features = lambda _t: _FakeTensor(
            np.ones((1, dim), dtype=np.float32),
        )
        mod.calculate_image_features = lambda _p: _FakeTensor(
            np.ones((1, dim), dtype=np.float32),
        )
        return mod

    monkeypatch.setitem(sys.modules, "ai.clip", make_module(768))
    monkeypatch.setitem(sys.modules, "ai.siglip_embed", make_module(1152))


async def test_text_vec_uses_clip_by_default(fake_encoders, monkeypatch) -> None:
    import shared
    from server.utils.vec import get_text_vec

    monkeypatch.setattr(shared, "search_embedding_backend", "clip")
    vec = await get_text_vec("hello")
    assert vec.shape == (768,)


async def test_text_vec_uses_siglip_when_selected(fake_encoders, monkeypatch) -> None:
    import shared
    from server.utils.vec import get_text_vec

    monkeypatch.setattr(shared, "search_embedding_backend", "siglip2")
    vec = await get_text_vec("你好")
    assert vec.shape == (1152,)
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd server && uv run pytest tests/test_vec_dispatch.py -v`
Expected: FAIL —`test_text_vec_uses_siglip_when_selected` 返回 768（当前 `get_text_vec` 写死 CLIP）。

- [ ] **Step 3: 改写 vec.py 按 backend 分派**

Replace `server/src/server/utils/vec.py` 全文为：

```python
"""图/文特征提取 helper（DB-free）。

embedding 的数据库访问在 ``db.repositories.vectors.VectorRepo``；本模块只做
前向。编码器按 ``shared.search_embedding_backend`` 分派：``"clip"`` 用
``ai.clip``（768d），``"siglip2"`` 用 ``ai.siglip_embed``（1152d，多语言）。
两个 ML 模块都在函数内 lazy import，避免在不需要检索时加载权重。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import numpy as np

import shared

if TYPE_CHECKING:
    from pathlib import Path


def _text_encoder():
    if shared.search_embedding_backend == "siglip2":
        from ai.siglip_embed import calculate_text_features  # noqa: PLC0415
    else:
        from ai.clip import calculate_text_features  # noqa: PLC0415
    return calculate_text_features


def _image_encoder():
    if shared.search_embedding_backend == "siglip2":
        from ai.siglip_embed import calculate_image_features  # noqa: PLC0415
    else:
        from ai.clip import calculate_image_features  # noqa: PLC0415
    return calculate_image_features


async def get_text_vec(prompt: str) -> np.ndarray:
    """把文本 prompt 编码成 float32 向量（维度随 backend：768 或 1152）。"""
    features = await asyncio.to_thread(_text_encoder(), prompt)
    return features.cpu().numpy()[0].astype(np.float32)


async def get_image_vec(image_path: Path) -> np.ndarray:
    """把图片文件编码成 float32 向量（维度随 backend：768 或 1152）。"""
    features = await asyncio.to_thread(_image_encoder(), image_path)
    return features.cpu().numpy()[0].astype(np.float32)
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd server && uv run pytest tests/test_vec_dispatch.py -v`
Expected: 2 passed。

- [ ] **Step 5: Lint + Commit**

```bash
cd server && uv run ruff check src/server/utils/vec.py
git add server/src/server/utils/vec.py server/tests/test_vec_dispatch.py
git commit -m "feat(search): dispatch text/image encoder by search backend"
```

---

## Task 6: DI provider 按 backend 选表

**Files:**
- Modify: `server/src/app.py:259-264`（`provide_vector_repo`）
- Test: `server/tests/test_vector_repo.py`（测一个可复用的选表 helper）

> `provide_vector_repo` 是 Litestar 的 async generator 依赖，直接单测较绕。
> 把"按 backend 选哪张表/维度"抽成纯函数 `vector_table_for_backend`，单测它；
> provider 只负责开/关 cursor 并调用该函数。

- [ ] **Step 1: 写失败测试**

在 `server/tests/test_vector_repo.py` 末尾追加：

```python
class TestBackendTableSelection:
    def test_clip_backend_uses_default_table(self) -> None:
        from db.repositories.vectors import vector_table_for_backend

        assert vector_table_for_backend("clip") == ("post_vectors", 768)

    def test_siglip_backend_uses_siglip_table(self) -> None:
        from db.repositories.vectors import vector_table_for_backend

        assert vector_table_for_backend("siglip2") == ("post_vectors_siglip2", 1152)

    def test_unknown_backend_falls_back_to_clip(self) -> None:
        from db.repositories.vectors import vector_table_for_backend

        assert vector_table_for_backend("nope") == ("post_vectors", 768)
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd server && uv run pytest tests/test_vector_repo.py::TestBackendTableSelection -v`
Expected: FAIL — `vector_table_for_backend` 不存在（ImportError）。

- [ ] **Step 3: 在 vectors.py 增加 helper**

在 `server/src/db/repositories/vectors.py` 的 `_ALLOWED_TABLES` 之后追加：

```python
def vector_table_for_backend(backend: str) -> tuple[str, int]:
    """把检索 backend 名映射到 (vec0 表名, 维度)。

    未知 backend 安全回退到 CLIP（旧默认），与
    ``utils.prepare_feature_flags`` 的回退策略一致。
    """
    if backend == "siglip2":
        return ("post_vectors_siglip2", _ALLOWED_TABLES["post_vectors_siglip2"])
    return ("post_vectors", _ALLOWED_TABLES["post_vectors"])
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd server && uv run pytest tests/test_vector_repo.py::TestBackendTableSelection -v`
Expected: 3 passed。

- [ ] **Step 5: 改 provide_vector_repo 用该 helper**

Modify `server/src/app.py` 的 `provide_vector_repo`：

```python
async def provide_vector_repo(state: State) -> AsyncGenerator[VectorRepo, None]:
    cur = state.db.cursor()
    table, dim = vector_table_for_backend(shared.search_embedding_backend)
    try:
        yield VectorRepo(cur, table=table, dim=dim)
    finally:
        cur.close()
```

并把 import 行 `from db.repositories.vectors import VectorRepo` 改为：

```python
from db.repositories.vectors import VectorRepo, vector_table_for_backend
```

确认 `app.py` 顶部已 `import shared`（已有；若无则补）。

- [ ] **Step 6: 跑全量测试 + lint**

Run: `cd server && uv run pytest -q && uv run ruff check src/app.py src/db/repositories/vectors.py`
Expected: 全绿、无 lint 错误。

- [ ] **Step 7: Commit**

```bash
git add server/src/app.py server/src/db/repositories/vectors.py server/tests/test_vector_repo.py
git commit -m "feat(search): provide_vector_repo selects table by backend"
```

---

## Task 7: SigLIP backfill worker + 新上传双写

**Files:**
- Modify: `server/src/processors/__init__.py`

> 此任务的批处理器与 worker 镜像现有 `_process_embedding_batch` /
> `run_embedding_worker`（两者均无单测，靠端到端验证）。逻辑无新分支，
> 只是换表 + 换编码器，故采用"镜像现有模式 + 手动验证"，不强行 TDD。

- [ ] **Step 1: 增加常量**

在 `server/src/processors/__init__.py` 的 `EMBEDDING_BATCH_SIZE = 32` 附近追加：

```python
# SigLIP 2 so400m 比 CLIP-L/14 大；batch=16 在 12GB bf16 下与美学打分同档稳妥。
SIGLIP_EMBED_BATCH_SIZE = 16
```

- [ ] **Step 2: 增加 SigLIP embedding 批处理器**

在 `_process_embedding_batch` 之后追加一个新函数（与之同构，换编码模块 + 换 repo 表 + 换失败 worker 名）：

```python
async def _process_siglip_embedding_batch(  # noqa: C901, PLR0912
    posts: PostRepo,
    vectors: VectorRepo,
    post_ids: list[int],
) -> None:
    """把一批图编码成 SigLIP 2 embedding 写入 post_vectors_siglip2。

    与 _process_embedding_batch 同构：整批前向失败时先降到 mini-batch，
    再降到单图，单图不可读则记 'embedding:siglip2' 一次性黑名单。
    ``vectors`` 必须是指向 post_vectors_siglip2 的 VectorRepo（dim=1152）。
    """
    from ai.siglip_embed import (  # noqa: PLC0415  # lazy: defer ML stack load
        calculate_image_features,
        calculate_image_features_batch,
    )

    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, abs_path))
    if not items:
        return

    paths = [p for _, p in items]
    try:
        features = await asyncio.to_thread(calculate_image_features_batch, paths)
    except Exception as exc:
        logger.warning(
            f"[siglip-embedding] batch failed ({exc!s}); "
            f"retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
        failed: list[tuple[int, str, str]] = []
        for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
            chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
            chunk_paths = [p for _, p in chunk]
            try:
                chunk_features = await asyncio.to_thread(
                    calculate_image_features_batch, chunk_paths,
                )
            except Exception as exc2:
                logger.warning(
                    f"[siglip-embedding] mini-batch failed ({exc2!s}); falling back per-image",
                )
                for pid, path in chunk:
                    try:
                        single = await asyncio.to_thread(calculate_image_features, path)
                        embedding = single.cpu().numpy()[0].astype(np.float32)
                        await vectors.upsert(pid, embedding)
                    except (UnidentifiedImageError, OSError) as exc3:
                        logger.warning(f"[siglip-embedding] skipping unreadable image {pid} ({path}): {exc3}")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
                    except Exception as exc3:
                        logger.exception(f"[siglip-embedding] post {pid} ({path})")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
            else:
                embeddings_np = chunk_features.cpu().numpy().astype(np.float32)
                for (pid, _), emb in zip(chunk, embeddings_np, strict=True):
                    await vectors.upsert(pid, emb)
        if failed:
            await FailureRepo(posts.cur).record_failures(failed)
        return

    embeddings_np = features.cpu().numpy().astype(np.float32)
    for (pid, _), emb in zip(items, embeddings_np, strict=True):
        await vectors.upsert(pid, emb)
```

- [ ] **Step 3: 增加 worker driver**

在 `run_embedding_worker` 之后追加：

```python
async def run_siglip_embedding_worker(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill SigLIP 2 图片 embedding 到 post_vectors_siglip2。"""
    pending = await vectors.list_missing_post_ids(
        image_exts=[ext.lstrip(".") for ext in IMAGE_EXTS],
        worker="embedding:siglip2",
    )

    async def _process(batch_ids: list[int]) -> None:
        await _process_siglip_embedding_batch(posts, vectors, batch_ids)

    await _drive(
        progress, "SigLIP embeddings", pending, SIGLIP_EMBED_BATCH_SIZE, _process,
        gpu_adaptive=True,
    )
```

- [ ] **Step 4: 接入 run_all_backfill**

在 `run_all_backfill` 内，给 SigLIP embedding worker 分配独立连接。在
`siglip_conn = _checkout() if shared.enable_siglip_scorer else None` 之后追加：

```python
    # SigLIP 2 检索 embedding 的 backfill 始终开启（与美学打分的 enable 开关无关），
    # 这样新表能在后台填满，等 search_embedding_backend 翻 siglip2 时即用。
    siglip_embed_conn = _checkout()
```

并在 `workers = [...]` 列表里（`run_embedding_worker(...)` 之后）追加：

```python
                run_siglip_embedding_worker(
                    PostRepo(siglip_embed_conn.cursor()),
                    VectorRepo(
                        siglip_embed_conn.cursor(),
                        table="post_vectors_siglip2",
                        dim=1152,
                    ),
                    progress=progress,
                ),
```

- [ ] **Step 5: process_post 双写新表**

在 `process_post` 内，`await _process_embedding_batch(posts, vectors, [post.id])`
那一行之后追加（`vectors` 参数是默认的 CLIP repo；新表需要单独的 repo）：

```python
    # 过渡期同时写 SigLIP 2 新表，保证切换时无缺口。复用同一 cursor 的连接
    # 另开一个指向新表的 VectorRepo。
    siglip_vectors = VectorRepo(posts.cur, table="post_vectors_siglip2", dim=1152)
    await _process_siglip_embedding_batch(posts, siglip_vectors, [post.id])
```

> 确认 `processors/__init__.py` 顶部已 `from db.repositories.vectors import VectorRepo`（已有）。

- [ ] **Step 6: 跑全量测试 + lint（确认无导入/语法回归）**

Run: `cd server && uv run pytest -q && uv run ruff check src/processors/__init__.py`
Expected: 全绿、无 lint 错误。（worker 本身不在单测覆盖内，本步只验证模块可导入、不破坏现有套件。）

- [ ] **Step 7: Commit**

```bash
git add server/src/processors/__init__.py
git commit -m "feat(processors): backfill SigLIP 2 embeddings + dual-write on upload"
```

---

## Task 8: 端到端手动验证（需 GPU + 真实图库）

> 这些步骤无法在 CI/无 GPU 环境自动化，由开发者在本地图库上跑一遍确认。

- [ ] **Step 1: 启动后端，让 backfill 跑起来**

Run: `cd server && uv run ./src/app.py --target_dir <你的图库>`
观察日志出现 `SigLIP embeddings` 进度条，且 `search_embedding_backend = clip`（默认）。

- [ ] **Step 2: 确认新表在填充**

Run: `cd server && uv run python scripts/inspect_db.py`（或直接 SQL）：
```sql
SELECT count(*) FROM post_vectors_siglip2;
SELECT count(*) FROM post_vectors;
```
Expected: `post_vectors_siglip2` 计数随 backfill 增长，最终逼近 `post_vectors`。

- [ ] **Step 3: 翻开关，重启，验证中文文搜图**

设 env `SEARCH_EMBEDDING_BACKEND=siglip2`，重启后端。
调 `POST /posts/search/text`，body `{"query": "一只橘猫"}`，确认返回相关结果
（CLIP backend 下中文 prompt 基本无效，这是迁移的核心收益）。

- [ ] **Step 4: 验证以图搜图 + 回滚**

调 `GET /posts/{id}/similar` 确认在 siglip2 下返回合理结果；再把 env 翻回
`clip` 重启，确认即时回滚到旧行为（无需重跑 backfill）。

- [ ] **Step 5: 更新文档（CLAUDE.md schema 段 + 搜索框 placeholder）**

- 在 `CLAUDE.md` 的「Database Schema」段补一行 `post_vectors_siglip2`（1152d SigLIP 2）。
- 可选：前端搜索框 placeholder 文案改为支持中文的提示（`web/` 内对应组件）。

```bash
git add CLAUDE.md web/...   # 视实际改动
git commit -m "docs: document post_vectors_siglip2 and multilingual search"
```

---

## Follow-up（本计划范围外，单独处理）

- 切换稳定运行一段时间后，新增迁移 `0007_drop_post_vectors_clip.sql` 删除旧表，
  并移除 `ai/clip.py`、`process_post` 的 CLIP 写入步骤、`vec.py` 的 clip 分支。
- 视需要把美学打分从 SigLIP v1 升到 v2（独立评估，与本次检索迁移解耦）。

---

## Self-Review 记录

- **Spec 覆盖**：模块(Task3)/数据层新表(Task1)/参数化 repo(Task2)/backfill worker+双写(Task7)/切换开关(Task4)/检索分派(Task5,6)/测试(贯穿)/手动验收(Task8) —— spec 各节均有对应任务。
- **占位符**：无 TBD/TODO；每个改代码的步骤都给了完整代码。
- **类型/命名一致性**：`vector_table_for_backend` / `_process_siglip_embedding_batch` /
  `run_siglip_embedding_worker` / `search_embedding_backend` / `SIGLIP_EMBED_BATCH_SIZE` /
  `_ALLOWED_TABLES` 在定义与引用处拼写一致；`VectorRepo(cur, table=..., dim=...)` 关键字参数
  在 Task2 定义、Task6/Task7 调用处签名一致。
- **失败 worker 名**：新表统一用 `"embedding:siglip2"`（Task2 的 `list_missing_post_ids`
  默认 worker 与 Task7 的传参、黑名单写入处一致）。
