# SILVA 多维标注基础设施 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pictoria 内建成最小可用的多维标注闭环：事件表 migration → repository → API → 导出 CLI → 全键盘标注 UI（单图多维 + pairwise）。

**Architecture:** append-only 事件流按形态分三张表（absolute / pairwise / content-flag），队列表按形态分两张 items 表；Litestar controller 走既有 `_cursor_scoped` 依赖注入；导出 CLI 直连 sqlite 聚合（最新优先）并 join `post_vectors_siglip2` 出 parquet；前端新增 `/annotate` 页面，键位映射抽成纯函数 composable 单测。

**Tech Stack:** Litestar + SQLite(WAL) + sqlite-vec、msgspec(请求)/Pydantic(响应)、pytest；Vue 3 + @vueuse/core onKeyStroke + @hey-api 生成 client、vitest。

**Spec:** `E:/code/silva/docs/superpowers/specs/2026-06-05-silva-multidim-annotation-design.md`

**工作目录:** Task 1–11 在 `E:/pictoria`，Task 12 在 `E:/code/silva`。

---

## File Structure

```
E:/pictoria/server/
  migrations/0011_annotations.sql              (create) 3 事件表 + queues + 2 items 表 + view
  src/db/entities.py                           (modify) +AbsoluteAnnotation/PairwiseAnnotation/ContentFlagEvent/AnnotationQueue
  src/db/repositories/annotations.py           (create) AnnotationRepo
  src/db/repositories/annotation_queues.py     (create) AnnotationQueueRepo
  src/server/annotations.py                    (create) AnnotationController
  src/server/annotation_queues.py              (create) AnnotationQueueController
  src/server/dependencies.py                   (modify) +2 providers
  src/app.py                                   (modify) v2 Router 注册 2 个 controller
  scripts/export_annotations.py                (create) 导出 CLI
  tests/test_annotation_repo.py                (create)
  tests/test_annotation_queue_repo.py          (create)
  tests/test_annotation_api.py                 (create)
  tests/test_export_annotations.py             (create)
E:/pictoria/web/src/
  main.ts                                      (modify) +/annotate 路由
  composables/useAnnotationKeymap.ts           (create) 键位映射纯函数
  views/Annotate.vue                           (create) 队列选择页
  components/annotate/AbsoluteAnnotationSession.vue   (create) 模式 A
  components/annotate/PairwiseAnnotationSession.vue   (create) 模式 B
  components/AnnotationHistory.vue             (create) 详情页标注历史
  components/PostDetailPanel.vue               (modify) 挂载 AnnotationHistory
  test/useAnnotationKeymap.test.ts             (create)
E:/code/silva/docs/rubrics/
  color.md / finish.md / composition.md        (create) 细则 v1 模板
```

约定（全计划通用）：

- dimension 合法值 `'color' | 'finish' | 'composition' | 'overall'`，应用层校验（migration 不 CHECK，留扩展）。
- 聚合策略：最新优先（同 post×dimension 取 `MAX(id)`）。
- server 测试命令：`cd E:/pictoria/server && uv run pytest <file> -v`。
- web 测试命令：`cd E:/pictoria/web && pnpm vitest run <file>`。
- commit 均在对应 repo 根目录执行。

---

### Task 1: Migration 0011 — 标注与队列表

**Files:**
- Create: `E:/pictoria/server/migrations/0011_annotations.sql`
- Test: `E:/pictoria/server/tests/test_annotation_repo.py`（先放 schema 存在性测试）

- [ ] **Step 1: 写失败测试**（conftest 的 `db` fixture 会自动跑全部 migrations）

```python
"""Tests for annotation tables and AnnotationRepo."""

from db import DB


def _table_names(db: DB) -> set[str]:
    cur = db.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    return {row[0] for row in cur.fetchall()}


def test_annotation_tables_exist(db: DB) -> None:
    names = _table_names(db)
    assert "absolute_annotations" in names
    assert "pairwise_annotations" in names
    assert "content_flag_events" in names
    assert "annotation_queues" in names
    assert "absolute_queue_items" in names
    assert "pairwise_queue_items" in names
    assert "annotation_timeline" in names  # view
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_repo.py -v`
Expected: FAIL — `assert 'absolute_annotations' in names`

- [ ] **Step 3: 写 migration**

`E:/pictoria/server/migrations/0011_annotations.sql`：

```sql
-- 标注事件（append-only，永不 UPDATE/DELETE）与标注队列。
-- 按形态分表：absolute / pairwise / content-flag 的消费路径完全分离。
-- dimension 合法值由应用层校验（'color'|'finish'|'composition'|'overall'），不 CHECK，留扩展。

CREATE TABLE absolute_annotations (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    post_id        INTEGER NOT NULL,
    dimension      TEXT    NOT NULL,
    scale          INTEGER NOT NULL CHECK (scale IN (2, 3, 5)),
    value          INTEGER NOT NULL,
    rubric_version TEXT    NOT NULL,
    session_id     TEXT    NOT NULL,
    elapsed_ms     INTEGER
);
CREATE INDEX idx_absolute_annotations_post ON absolute_annotations (post_id, dimension);

CREATE TABLE pairwise_annotations (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    post_a         INTEGER NOT NULL,
    post_b         INTEGER NOT NULL CHECK (post_b != post_a),
    dimension      TEXT    NOT NULL,
    winner         TEXT    NOT NULL CHECK (winner IN ('a', 'b', 'tie', 'skip')),
    rubric_version TEXT    NOT NULL,
    session_id     TEXT    NOT NULL,
    elapsed_ms     INTEGER
);
CREATE INDEX idx_pairwise_annotations_posts ON pairwise_annotations (post_a, post_b, dimension);

CREATE TABLE content_flag_events (
    id         INTEGER PRIMARY KEY,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    post_id    INTEGER NOT NULL,
    flag       TEXT    NOT NULL CHECK (flag IN ('love', 'hate', 'none')),
    session_id TEXT    NOT NULL
);
CREATE INDEX idx_content_flag_events_post ON content_flag_events (post_id);

CREATE TABLE annotation_queues (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('absolute', 'pairwise')),
    dimensions TEXT    NOT NULL,            -- JSON list of dimension keys
    scale      INTEGER,                     -- absolute 队列用；pairwise 为 NULL
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE absolute_queue_items (
    queue_id INTEGER NOT NULL REFERENCES annotation_queues(id),
    position INTEGER NOT NULL,
    post_id  INTEGER NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, position)
);

CREATE TABLE pairwise_queue_items (
    queue_id INTEGER NOT NULL REFERENCES annotation_queues(id),
    position INTEGER NOT NULL,
    post_a   INTEGER NOT NULL,
    post_b   INTEGER NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (queue_id, position)
);

CREATE VIEW annotation_timeline AS
    SELECT id, created_at, 'absolute' AS kind, post_id, dimension, session_id FROM absolute_annotations
    UNION ALL
    SELECT id, created_at, 'pairwise' AS kind, post_a AS post_id, dimension, session_id FROM pairwise_annotations;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_repo.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd E:/pictoria && git add server/migrations/0011_annotations.sql server/tests/test_annotation_repo.py
git commit -m "feat(db): annotation event and queue tables (migration 0011)"
```

---

### Task 2: Entities + AnnotationRepo

**Files:**
- Modify: `E:/pictoria/server/src/db/entities.py`（文件末尾追加）
- Create: `E:/pictoria/server/src/db/repositories/annotations.py`
- Test: `E:/pictoria/server/tests/test_annotation_repo.py`（追加）

- [ ] **Step 1: 写失败测试**（追加到 `tests/test_annotation_repo.py`；conftest 已 seed posts id=1..N）

```python
import pytest

from db.repositories.annotations import AnnotationRepo


@pytest.fixture
def annotations(db: DB) -> AnnotationRepo:
    return AnnotationRepo(db.cursor())


async def test_insert_and_list_absolute(annotations: AnnotationRepo) -> None:
    eid = await annotations.insert_absolute(
        post_id=1, dimension="color", scale=2, value=2,
        rubric_version="color-v1", session_id="s1", elapsed_ms=1234,
    )
    assert eid > 0
    rows = await annotations.list_absolute_for_post(1)
    assert len(rows) == 1
    assert rows[0].dimension == "color"
    assert rows[0].scale == 2
    assert rows[0].value == 2
    assert rows[0].elapsed_ms == 1234


async def test_absolute_is_append_only(annotations: AnnotationRepo) -> None:
    await annotations.insert_absolute(post_id=1, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    await annotations.insert_absolute(post_id=1, dimension="color", scale=2, value=2, rubric_version="color-v1", session_id="s2")
    rows = await annotations.list_absolute_for_post(1)
    assert len(rows) == 2  # 重复标注追加而非覆盖


async def test_insert_and_list_pairwise(annotations: AnnotationRepo) -> None:
    eid = await annotations.insert_pairwise(
        post_a=1, post_b=2, dimension="composition", winner="a",
        rubric_version="composition-v1", session_id="s1", elapsed_ms=2000,
    )
    assert eid > 0
    rows = await annotations.list_pairwise_for_post(2)  # post_b 也能查到
    assert len(rows) == 1
    assert rows[0].winner == "a"


async def test_content_flag_latest(annotations: AnnotationRepo) -> None:
    assert await annotations.latest_content_flag(1) is None
    await annotations.insert_content_flag(post_id=1, flag="love", session_id="s1")
    await annotations.insert_content_flag(post_id=1, flag="none", session_id="s1")
    latest = await annotations.latest_content_flag(1)
    assert latest is not None
    assert latest.flag == "none"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_repo.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'db.repositories.annotations'`

- [ ] **Step 3: 追加 entities**（`src/db/entities.py` 末尾，沿用 `_Entity` 基类）

```python
class AbsoluteAnnotation(_Entity):
    id: int
    created_at: datetime
    post_id: int
    dimension: str
    scale: int
    value: int
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class PairwiseAnnotation(_Entity):
    id: int
    created_at: datetime
    post_a: int
    post_b: int
    dimension: str
    winner: str  # 'a' | 'b' | 'tie' | 'skip'
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class ContentFlagEvent(_Entity):
    id: int
    created_at: datetime
    post_id: int
    flag: str  # 'love' | 'hate' | 'none'
    session_id: str
```

- [ ] **Step 4: 写 AnnotationRepo**（`src/db/repositories/annotations.py`，模式照搬 `posts.py`：`asyncio.to_thread` + `?` 参数绑定 + `fetch_one_as`/`fetch_all_as`）

```python
"""Append-only annotation event repository (absolute / pairwise / content-flag)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from db.entities import AbsoluteAnnotation, ContentFlagEvent, PairwiseAnnotation
from db.helpers import fetch_all_as, fetch_one_as

if TYPE_CHECKING:
    import sqlite3

ABSOLUTE_COLUMNS = "id, created_at, post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms"
PAIRWISE_COLUMNS = "id, created_at, post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms"
FLAG_COLUMNS = "id, created_at, post_id, flag, session_id"


class AnnotationRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def insert_absolute(
        self,
        *,
        post_id: int,
        dimension: str,
        scale: int,
        value: int,
        rubric_version: str,
        session_id: str,
        elapsed_ms: int | None = None,
    ) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO absolute_annotations (post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms],
            )
            return int(self.cur.lastrowid or 0)

        return await asyncio.to_thread(_impl)

    async def insert_pairwise(
        self,
        *,
        post_a: int,
        post_b: int,
        dimension: str,
        winner: str,
        rubric_version: str,
        session_id: str,
        elapsed_ms: int | None = None,
    ) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms],
            )
            return int(self.cur.lastrowid or 0)

        return await asyncio.to_thread(_impl)

    async def insert_content_flag(self, *, post_id: int, flag: str, session_id: str) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO content_flag_events (post_id, flag, session_id) VALUES (?, ?, ?)",
                [post_id, flag, session_id],
            )
            return int(self.cur.lastrowid or 0)

        return await asyncio.to_thread(_impl)

    async def list_absolute_for_post(self, post_id: int) -> list[AbsoluteAnnotation]:
        def _impl() -> list[AbsoluteAnnotation]:
            self.cur.execute(
                f"SELECT {ABSOLUTE_COLUMNS} FROM absolute_annotations WHERE post_id = ? ORDER BY id",  # noqa: S608
                [post_id],
            )
            return fetch_all_as(self.cur, AbsoluteAnnotation)

        return await asyncio.to_thread(_impl)

    async def list_pairwise_for_post(self, post_id: int) -> list[PairwiseAnnotation]:
        def _impl() -> list[PairwiseAnnotation]:
            self.cur.execute(
                f"SELECT {PAIRWISE_COLUMNS} FROM pairwise_annotations WHERE post_a = ? OR post_b = ? ORDER BY id",  # noqa: S608
                [post_id, post_id],
            )
            return fetch_all_as(self.cur, PairwiseAnnotation)

        return await asyncio.to_thread(_impl)

    async def latest_content_flag(self, post_id: int) -> ContentFlagEvent | None:
        def _impl() -> ContentFlagEvent | None:
            self.cur.execute(
                f"SELECT {FLAG_COLUMNS} FROM content_flag_events WHERE post_id = ? ORDER BY id DESC LIMIT 1",  # noqa: S608
                [post_id],
            )
            return fetch_one_as(self.cur, ContentFlagEvent)

        return await asyncio.to_thread(_impl)
```

注意：若 `db/helpers.py` 中没有 `fetch_all_as`（只有 `fetch_one_as` / `fetch_all_dicts`），按 `fetch_one_as` 同样模式补一个：

```python
def fetch_all_as(cur: sqlite3.Cursor, model_cls: type[T]) -> list[T]:
    cols = _column_names(cur)
    return [model_cls.model_validate(dict(zip(cols, row, strict=False))) for row in cur.fetchall()]
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_repo.py -v`
Expected: PASS（全部 5 个测试）

- [ ] **Step 6: Lint + Commit**

```bash
cd E:/pictoria/server && uv run ruff check src tests
cd E:/pictoria && git add server/src/db/entities.py server/src/db/repositories/annotations.py server/src/db/helpers.py server/tests/test_annotation_repo.py
git commit -m "feat(db): AnnotationRepo for append-only annotation events"
```

---

### Task 3: AnnotationQueueRepo

**Files:**
- Modify: `E:/pictoria/server/src/db/entities.py`（追加 AnnotationQueue）
- Create: `E:/pictoria/server/src/db/repositories/annotation_queues.py`
- Test: `E:/pictoria/server/tests/test_annotation_queue_repo.py`

- [ ] **Step 1: 写失败测试**

```python
"""Tests for AnnotationQueueRepo."""

import pytest

from db import DB
from db.repositories.annotation_queues import AnnotationQueueRepo


@pytest.fixture
def queues(db: DB) -> AnnotationQueueRepo:
    return AnnotationQueueRepo(db.cursor())


async def test_create_and_list_absolute_queue(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(
        name="coldstart-1", dimensions=["color", "finish", "composition"], scale=2, post_ids=[1, 2, 3],
    )
    assert qid > 0
    rows = await queues.list_queues()
    assert len(rows) == 1
    queue, total, done = rows[0]
    assert queue.name == "coldstart-1"
    assert queue.kind == "absolute"
    assert queue.dimensions == ["color", "finish", "composition"]
    assert queue.scale == 2
    assert total == 3
    assert done == 0


async def test_next_absolute_items_and_mark_done(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(name="q", dimensions=["color"], scale=2, post_ids=[1, 2])
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [0, 1]
    assert items[0]["post_id"] == 1
    assert "file_name" in items[0]  # join posts，前端拼图片 URL 用

    await queues.mark_done(qid, kind="absolute", position=0)
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [1]


async def test_pairwise_queue_roundtrip(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_pairwise_queue(name="pq", dimensions=["color"], pairs=[(1, 2), (2, 3)])
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 2
    assert items[0]["a_post_id"] == 1
    assert items[0]["b_post_id"] == 2
    await queues.mark_done(qid, kind="pairwise", position=0)
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_queue_repo.py -v`
Expected: FAIL — ModuleNotFoundError

- [ ] **Step 3: 追加 entity**（`src/db/entities.py`；dimensions 列存 JSON 字符串，validator 解码）

```python
class AnnotationQueue(_Entity):
    id: int
    name: str
    kind: str  # 'absolute' | 'pairwise'
    dimensions: list[str]
    scale: int | None = None
    created_at: datetime

    @field_validator("dimensions", mode="before")
    @classmethod
    def _decode_dimensions(cls, v: object) -> object:
        if isinstance(v, str):
            return json.loads(v)
        return v
```

（确认文件头部已有 `import json` 与 `from pydantic import field_validator`，没有则补上。）

- [ ] **Step 4: 写 AnnotationQueueRepo**（`src/db/repositories/annotation_queues.py`）

```python
"""Annotation queue repository: what to annotate next, fed by silva-side samplers."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from db.entities import AnnotationQueue
from db.helpers import fetch_all_dicts

if TYPE_CHECKING:
    import sqlite3

QUEUE_COLUMNS = "id, name, kind, dimensions, scale, created_at"
_POST_FIELDS = "p.id AS post_id, p.file_path, p.file_name, p.extension, p.sha256, p.width, p.height"
_ITEM_TABLES = {"absolute": "absolute_queue_items", "pairwise": "pairwise_queue_items"}


class AnnotationQueueRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def create_absolute_queue(self, *, name: str, dimensions: list[str], scale: int, post_ids: list[int]) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'absolute', ?, ?)",
                [name, json.dumps(dimensions), scale],
            )
            qid = int(self.cur.lastrowid or 0)
            self.cur.executemany(
                "INSERT INTO absolute_queue_items (queue_id, position, post_id) VALUES (?, ?, ?)",
                [(qid, pos, pid) for pos, pid in enumerate(post_ids)],
            )
            return qid

        return await asyncio.to_thread(_impl)

    async def create_pairwise_queue(self, *, name: str, dimensions: list[str], pairs: list[tuple[int, int]]) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'pairwise', ?, NULL)",
                [name, json.dumps(dimensions)],
            )
            qid = int(self.cur.lastrowid or 0)
            self.cur.executemany(
                "INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b) VALUES (?, ?, ?, ?)",
                [(qid, pos, a, b) for pos, (a, b) in enumerate(pairs)],
            )
            return qid

        return await asyncio.to_thread(_impl)

    async def get(self, queue_id: int) -> AnnotationQueue | None:
        def _impl() -> AnnotationQueue | None:
            self.cur.execute(
                f"SELECT {QUEUE_COLUMNS} FROM annotation_queues WHERE id = ?",  # noqa: S608
                [queue_id],
            )
            row = self.cur.fetchone()
            if row is None:
                return None
            cols = [d[0] for d in self.cur.description]
            return AnnotationQueue.model_validate(dict(zip(cols, row, strict=False)))

        return await asyncio.to_thread(_impl)

    async def list_queues(self) -> list[tuple[AnnotationQueue, int, int]]:
        """Return (queue, total_items, done_items) for every queue, newest first."""

        def _impl() -> list[tuple[AnnotationQueue, int, int]]:
            self.cur.execute(f"SELECT {QUEUE_COLUMNS} FROM annotation_queues ORDER BY id DESC")  # noqa: S608
            cols = [d[0] for d in self.cur.description]
            queues = [AnnotationQueue.model_validate(dict(zip(cols, row, strict=False))) for row in self.cur.fetchall()]
            out: list[tuple[AnnotationQueue, int, int]] = []
            for q in queues:
                table = _ITEM_TABLES[q.kind]
                self.cur.execute(
                    f"SELECT COUNT(*), COALESCE(SUM(done), 0) FROM {table} WHERE queue_id = ?",  # noqa: S608
                    [q.id],
                )
                total, done = self.cur.fetchone()
                out.append((q, int(total), int(done)))
            return out

        return await asyncio.to_thread(_impl)

    async def next_absolute_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        def _impl() -> list[dict[str, Any]]:
            self.cur.execute(
                f"SELECT i.position, {_POST_FIELDS} "  # noqa: S608
                "FROM absolute_queue_items i JOIN posts p ON p.id = i.post_id "
                "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
                [queue_id, limit],
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def next_pairwise_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        def _impl() -> list[dict[str, Any]]:
            self.cur.execute(
                "SELECT i.position, "  # noqa: S608
                "pa.id AS a_post_id, pa.file_path AS a_file_path, pa.file_name AS a_file_name, pa.extension AS a_extension, pa.sha256 AS a_sha256, pa.width AS a_width, pa.height AS a_height, "
                "pb.id AS b_post_id, pb.file_path AS b_file_path, pb.file_name AS b_file_name, pb.extension AS b_extension, pb.sha256 AS b_sha256, pb.width AS b_width, pb.height AS b_height "
                "FROM pairwise_queue_items i "
                "JOIN posts pa ON pa.id = i.post_a JOIN posts pb ON pb.id = i.post_b "
                "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
                [queue_id, limit],
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def mark_done(self, queue_id: int, *, kind: str, position: int) -> bool:
        table = _ITEM_TABLES[kind]

        def _impl() -> bool:
            self.cur.execute(
                f"UPDATE {table} SET done = 1 WHERE queue_id = ? AND position = ?",  # noqa: S608
                [queue_id, position],
            )
            return self.cur.rowcount > 0

        return await asyncio.to_thread(_impl)
```

（若 `fetch_all_dicts` 不在 `db/helpers.py`，按既有 helper 风格补：`return [dict(zip(cols, row, strict=False)) for row in cur.fetchall()]`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_queue_repo.py -v`
Expected: PASS（3 个测试）

- [ ] **Step 6: Lint + Commit**

```bash
cd E:/pictoria/server && uv run ruff check src tests
cd E:/pictoria && git add server/src/db/entities.py server/src/db/repositories/annotation_queues.py server/tests/test_annotation_queue_repo.py
git commit -m "feat(db): AnnotationQueueRepo with per-kind item tables"
```

---

### Task 4: AnnotationController（事件提交 + 标注历史）

**Files:**
- Create: `E:/pictoria/server/src/server/annotations.py`
- Modify: `E:/pictoria/server/src/server/dependencies.py`
- Test: `E:/pictoria/server/tests/test_annotation_api.py`

- [ ] **Step 1: 写失败测试**（fixture 模仿 `tests/test_api_characterization.py` 的 `api_client`）

```python
"""HTTP tests for annotation + queue endpoints."""

from contextlib import asynccontextmanager
from typing import Iterator

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

from db import DB
from server.annotation_queues import AnnotationQueueController
from server.annotations import AnnotationController
from server.dependencies import REQUEST_DEPENDENCIES
from server.exceptions import DomainError, domain_error_handler


@pytest.fixture
def api_client(db: DB) -> Iterator[TestClient]:
    @asynccontextmanager
    async def _lifespan(app: Litestar):
        app.state.db = db
        yield

    app = Litestar(
        route_handlers=[Router("/v2", route_handlers=[AnnotationController, AnnotationQueueController])],
        dependencies=REQUEST_DEPENDENCIES,
        exception_handlers={DomainError: domain_error_handler},
        plugins=[PydanticPlugin(prefer_alias=True)],
        lifespan=[_lifespan],
    )
    with TestClient(app=app) as client:
        yield client


def test_submit_absolute_batch(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/absolute",
        json={
            "events": [
                {"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1", "elapsed_ms": 900},
                {"post_id": 1, "dimension": "finish", "scale": 2, "value": 1, "rubric_version": "finish-v1", "session_id": "s1", "elapsed_ms": 400},
            ],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["inserted"] == 2


def test_submit_pairwise(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/pairwise",
        json={"post_a": 1, "post_b": 2, "dimension": "color", "winner": "b", "rubric_version": "color-v1", "session_id": "s1"},
    )
    assert resp.status_code == 201


def test_submit_content_flag(api_client: TestClient) -> None:
    resp = api_client.post("/v2/annotations/content-flag", json={"post_id": 1, "flag": "love", "session_id": "s1"})
    assert resp.status_code == 201


def test_invalid_dimension_rejected(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "vibes", "scale": 2, "value": 1, "rubric_version": "v1", "session_id": "s1"}]},
    )
    assert resp.status_code == 400


def test_post_annotation_history(api_client: TestClient) -> None:
    api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"}]},
    )
    api_client.post("/v2/annotations/content-flag", json={"post_id": 1, "flag": "hate", "session_id": "s1"})
    resp = api_client.get("/v2/annotations/post/1")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["absolute"]) == 1
    assert body["absolute"][0]["dimension"] == "color"
    assert body["contentFlag"] == "hate"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_api.py -v`
Expected: FAIL — ModuleNotFoundError（annotations / annotation_queues controller 不存在）。
（注意：fixture import 了 Task 5 的 `AnnotationQueueController`。本 Task 先建一个只有 path 的空壳类让 import 通过，Task 5 再填实现。）

- [ ] **Step 3: 写 AnnotationController**（`src/server/annotations.py`；请求用 msgspec Struct（与 `PostFilter` 一致），响应用 `scheme.DTOBaseModel`（camelCase））

```python
"""Annotation endpoints: submit append-only events, read per-post history."""

from __future__ import annotations

from datetime import datetime
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import ValidationException
from msgspec import Struct

from db.entities import AbsoluteAnnotation, PairwiseAnnotation
from db.repositories.annotations import AnnotationRepo
from db.repositories.annotation_queues import AnnotationQueueRepo
from scheme import DTOBaseModel

VALID_DIMENSIONS = {"color", "finish", "composition", "overall"}
VALID_FLAGS = {"love", "hate", "none"}
VALID_WINNERS = {"a", "b", "tie", "skip"}


class AbsoluteEventIn(Struct):
    post_id: int
    dimension: str
    scale: int
    value: int
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class AbsoluteBatchIn(Struct):
    events: list[AbsoluteEventIn]
    queue_id: int | None = None
    queue_position: int | None = None


class PairwiseEventIn(Struct):
    post_a: int
    post_b: int
    dimension: str
    winner: str
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None
    queue_id: int | None = None
    queue_position: int | None = None


class ContentFlagIn(Struct):
    post_id: int
    flag: str
    session_id: str


class InsertedPublic(DTOBaseModel):
    inserted: int


class AbsoluteAnnotationPublic(DTOBaseModel):
    id: int
    created_at: datetime
    post_id: int
    dimension: str
    scale: int
    value: int
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class PairwiseAnnotationPublic(DTOBaseModel):
    id: int
    created_at: datetime
    post_a: int
    post_b: int
    dimension: str
    winner: str
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class PostAnnotationsPublic(DTOBaseModel):
    absolute: list[AbsoluteAnnotationPublic]
    pairwise: list[PairwiseAnnotationPublic]
    content_flag: str | None = None


def _validate_absolute(e: AbsoluteEventIn) -> None:
    if e.dimension not in VALID_DIMENSIONS:
        msg = f"invalid dimension: {e.dimension!r}"
        raise ValidationException(msg)
    if e.scale not in (2, 3, 5):
        msg = f"invalid scale: {e.scale}"
        raise ValidationException(msg)
    if not 1 <= e.value <= e.scale:
        msg = f"value {e.value} out of range for scale {e.scale}"
        raise ValidationException(msg)


class AnnotationController(Controller):
    path = "/annotations"
    tags: ClassVar[list[str]] = ["Annotations"]

    @litestar.post("/absolute", status_code=201, description="Submit a batch of absolute annotation events (one image, several dimensions). Optionally marks a queue item done.")
    async def submit_absolute(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        data: AbsoluteBatchIn,
    ) -> InsertedPublic:
        for e in data.events:
            _validate_absolute(e)
        for e in data.events:
            await annotations.insert_absolute(
                post_id=e.post_id, dimension=e.dimension, scale=e.scale, value=e.value,
                rubric_version=e.rubric_version, session_id=e.session_id, elapsed_ms=e.elapsed_ms,
            )
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind="absolute", position=data.queue_position)
        return InsertedPublic(inserted=len(data.events))

    @litestar.post("/pairwise", status_code=201, description="Submit one pairwise judgement. Optionally marks a queue item done.")
    async def submit_pairwise(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        data: PairwiseEventIn,
    ) -> InsertedPublic:
        if data.dimension not in VALID_DIMENSIONS:
            msg = f"invalid dimension: {data.dimension!r}"
            raise ValidationException(msg)
        if data.winner not in VALID_WINNERS:
            msg = f"invalid winner: {data.winner!r}"
            raise ValidationException(msg)
        await annotations.insert_pairwise(
            post_a=data.post_a, post_b=data.post_b, dimension=data.dimension, winner=data.winner,
            rubric_version=data.rubric_version, session_id=data.session_id, elapsed_ms=data.elapsed_ms,
        )
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind="pairwise", position=data.queue_position)
        return InsertedPublic(inserted=1)

    @litestar.post("/content-flag", status_code=201, description="Record a content taste flag for a post ('none' = retract).")
    async def submit_content_flag(self, annotations: AnnotationRepo, data: ContentFlagIn) -> InsertedPublic:
        if data.flag not in VALID_FLAGS:
            msg = f"invalid flag: {data.flag!r}"
            raise ValidationException(msg)
        await annotations.insert_content_flag(post_id=data.post_id, flag=data.flag, session_id=data.session_id)
        return InsertedPublic(inserted=1)

    @litestar.get("/post/{post_id:int}", status_code=200, description="Full annotation history for a post.")
    async def post_history(self, annotations: AnnotationRepo, post_id: int) -> PostAnnotationsPublic:
        absolute = await annotations.list_absolute_for_post(post_id)
        pairwise = await annotations.list_pairwise_for_post(post_id)
        flag = await annotations.latest_content_flag(post_id)
        return PostAnnotationsPublic(
            absolute=[AbsoluteAnnotationPublic.model_validate(a, from_attributes=True) for a in absolute],
            pairwise=[PairwiseAnnotationPublic.model_validate(p, from_attributes=True) for p in pairwise],
            content_flag=None if flag is None or flag.flag == "none" else flag.flag,
        )
```

（`ValidationException` 若被 Litestar 映射为 400 即满足测试；若既有约定用 `DomainError` 子类，则改用之。）

- [ ] **Step 4: 建 AnnotationQueueController 空壳**（`src/server/annotation_queues.py`，Task 5 填实现）

```python
"""Annotation queue endpoints (filled in by the queue task)."""

from __future__ import annotations

from typing import ClassVar

from litestar import Controller


class AnnotationQueueController(Controller):
    path = "/annotation-queues"
    tags: ClassVar[list[str]] = ["Annotations"]
```

- [ ] **Step 5: 注册 dependencies**（`src/server/dependencies.py`）

```python
from db.repositories.annotations import AnnotationRepo
from db.repositories.annotation_queues import AnnotationQueueRepo

provide_annotation_repo = _cursor_scoped(AnnotationRepo)
provide_annotation_queue_repo = _cursor_scoped(AnnotationQueueRepo)

REQUEST_DEPENDENCIES = {
    # ... 既有条目保持不动 ...
    "annotations": provide_annotation_repo,
    "annotation_queues": provide_annotation_queue_repo,
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_api.py -v`
Expected: PASS（5 个测试；queue 相关端点测试在 Task 5 再加）

- [ ] **Step 7: Lint + Commit**

```bash
cd E:/pictoria/server && uv run ruff check src tests
cd E:/pictoria && git add server/src/server/annotations.py server/src/server/annotation_queues.py server/src/server/dependencies.py server/tests/test_annotation_api.py
git commit -m "feat(api): annotation event submission and per-post history endpoints"
```

---

### Task 5: AnnotationQueueController + app 注册

**Files:**
- Modify: `E:/pictoria/server/src/server/annotation_queues.py`（填实现）
- Modify: `E:/pictoria/server/src/app.py`（v2 Router 注册两个 controller）
- Test: `E:/pictoria/server/tests/test_annotation_api.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
def test_create_and_consume_absolute_queue(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotation-queues/absolute",
        json={"name": "coldstart-1", "dimensions": ["color", "finish"], "scale": 2, "post_ids": [1, 2]},
    )
    assert resp.status_code == 201
    qid = resp.json()["id"]

    resp = api_client.get("/v2/annotation-queues")
    assert resp.status_code == 200
    queues = resp.json()
    assert queues[0]["name"] == "coldstart-1"
    assert queues[0]["total"] == 2
    assert queues[0]["done"] == 0

    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-absolute?limit=10")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    assert items[0]["post"]["id"] == 1

    # 提交事件并标记 done 后，next 不再返回该 item
    api_client.post(
        "/v2/annotations/absolute",
        json={
            "events": [
                {"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"},
                {"post_id": 1, "dimension": "finish", "scale": 2, "value": 1, "rubric_version": "finish-v1", "session_id": "s1"},
            ],
            "queue_id": qid,
            "queue_position": 0,
        },
    )
    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-absolute?limit=10")
    assert len(resp.json()) == 1


def test_create_and_consume_pairwise_queue(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotation-queues/pairwise",
        json={"name": "pairs-1", "dimensions": ["color"], "pairs": [[1, 2], [2, 3]]},
    )
    assert resp.status_code == 201
    qid = resp.json()["id"]

    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-pairwise?limit=10")
    items = resp.json()
    assert len(items) == 2
    assert items[0]["postA"]["id"] == 1
    assert items[0]["postB"]["id"] == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_annotation_api.py -v`
Expected: 新增 2 个测试 FAIL（404 — 路由不存在）

- [ ] **Step 3: 填 AnnotationQueueController 实现**

```python
"""Annotation queue endpoints: create queues (fed by silva samplers), serve next items."""

from __future__ import annotations

from typing import ClassVar

import litestar
from litestar import Controller
from msgspec import Struct

from db.repositories.annotation_queues import AnnotationQueueRepo
from scheme import DTOBaseModel


class AbsoluteQueueCreate(Struct):
    name: str
    dimensions: list[str]
    scale: int
    post_ids: list[int]


class PairwiseQueueCreate(Struct):
    name: str
    dimensions: list[str]
    pairs: list[tuple[int, int]]


class QueueCreatedPublic(DTOBaseModel):
    id: int


class QueueSummaryPublic(DTOBaseModel):
    id: int
    name: str
    kind: str
    dimensions: list[str]
    scale: int | None = None
    total: int
    done: int


class QueueItemPostPublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    sha256: str
    width: int
    height: int


class AbsoluteQueueItemPublic(DTOBaseModel):
    position: int
    post: QueueItemPostPublic


class PairwiseQueueItemPublic(DTOBaseModel):
    position: int
    post_a: QueueItemPostPublic
    post_b: QueueItemPostPublic


def _post_from_prefix(row: dict, prefix: str = "") -> QueueItemPostPublic:
    g = lambda k: row[f"{prefix}{k}"]  # noqa: E731
    return QueueItemPostPublic(
        id=g("post_id"), file_path=g("file_path"), file_name=g("file_name"),
        extension=g("extension"), sha256=g("sha256"), width=g("width"), height=g("height"),
    )


class AnnotationQueueController(Controller):
    path = "/annotation-queues"
    tags: ClassVar[list[str]] = ["Annotations"]

    @litestar.post("/absolute", status_code=201, description="Create an absolute-annotation queue from an ordered post-id list.")
    async def create_absolute(self, annotation_queues: AnnotationQueueRepo, data: AbsoluteQueueCreate) -> QueueCreatedPublic:
        qid = await annotation_queues.create_absolute_queue(
            name=data.name, dimensions=data.dimensions, scale=data.scale, post_ids=data.post_ids,
        )
        return QueueCreatedPublic(id=qid)

    @litestar.post("/pairwise", status_code=201, description="Create a pairwise queue from an ordered (post_a, post_b) list.")
    async def create_pairwise(self, annotation_queues: AnnotationQueueRepo, data: PairwiseQueueCreate) -> QueueCreatedPublic:
        qid = await annotation_queues.create_pairwise_queue(name=data.name, dimensions=data.dimensions, pairs=[tuple(p) for p in data.pairs])
        return QueueCreatedPublic(id=qid)

    @litestar.get("/", status_code=200, description="List queues with progress, newest first.")
    async def list_queues(self, annotation_queues: AnnotationQueueRepo) -> list[QueueSummaryPublic]:
        rows = await annotation_queues.list_queues()
        return [
            QueueSummaryPublic(id=q.id, name=q.name, kind=q.kind, dimensions=q.dimensions, scale=q.scale, total=total, done=done)
            for q, total, done in rows
        ]

    @litestar.get("/{queue_id:int}/next-absolute", status_code=200, description="Next undone items of an absolute queue, with image info.")
    async def next_absolute(self, annotation_queues: AnnotationQueueRepo, queue_id: int, limit: int = 20) -> list[AbsoluteQueueItemPublic]:
        items = await annotation_queues.next_absolute_items(queue_id, limit=limit)
        return [AbsoluteQueueItemPublic(position=r["position"], post=_post_from_prefix(r)) for r in items]

    @litestar.get("/{queue_id:int}/next-pairwise", status_code=200, description="Next undone items of a pairwise queue, with image info for both posts.")
    async def next_pairwise(self, annotation_queues: AnnotationQueueRepo, queue_id: int, limit: int = 20) -> list[PairwiseQueueItemPublic]:
        items = await annotation_queues.next_pairwise_items(queue_id, limit=limit)
        return [
            PairwiseQueueItemPublic(position=r["position"], post_a=_post_from_prefix(r, "a_"), post_b=_post_from_prefix(r, "b_"))
            for r in items
        ]
```

- [ ] **Step 4: app.py 注册**（v2 Router 的 `route_handlers` 列表追加）

```python
from server.annotations import AnnotationController
from server.annotation_queues import AnnotationQueueController

v2 = Router(
    path="/v2",
    route_handlers=[
        PostController, CommandController, ImageController, TagsController,
        FoldersController, StatisticsController,
        AnnotationController, AnnotationQueueController,
    ],
)
```

- [ ] **Step 5: 跑全部 server 测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest -v`
Expected: PASS（既有测试 + 新增全部）

- [ ] **Step 6: Lint + Commit**

```bash
cd E:/pictoria/server && uv run ruff check src tests
cd E:/pictoria && git add server/src/server/annotation_queues.py server/src/app.py server/tests/test_annotation_api.py
git commit -m "feat(api): annotation queue create/list/next endpoints"
```

---

### Task 6: 导出 CLI（parquet）

**Files:**
- Create: `E:/pictoria/server/scripts/export_annotations.py`
- Test: `E:/pictoria/server/tests/test_export_annotations.py`
- Modify: `E:/pictoria/server/pyproject.toml`（确认/添加 pyarrow 依赖）

- [ ] **Step 1: 加依赖**

Run: `cd E:/pictoria/server && uv add pyarrow`
（若 pyproject 已有则跳过。）

- [ ] **Step 2: 写失败测试**

```python
"""Tests for the annotation export CLI (latest-wins aggregation + embedding join)."""

import sqlite_vec

from db import DB
from db.repositories.annotations import AnnotationRepo

from scripts.export_annotations import export_absolute, export_pairwise  # noqa: E402  (scripts on path via conftest or sys.path)

DIM = 1152


def _seed_embeddings(db: DB, post_ids: list[int]) -> None:
    cur = db.cursor()
    for pid in post_ids:
        blob = sqlite_vec.serialize_float32([0.01 * pid] * DIM)
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, blob],
        )


async def test_export_absolute_latest_wins(db: DB, tmp_path) -> None:
    _seed_embeddings(db, [1, 2])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_absolute(post_id=1, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    await repo.insert_absolute(post_id=1, dimension="color", scale=2, value=2, rubric_version="color-v1", session_id="s2")  # 最新优先应取这条
    await repo.insert_absolute(post_id=2, dimension="finish", scale=2, value=1, rubric_version="finish-v1", session_id="s2")

    out = tmp_path / "absolute.parquet"
    n = export_absolute(db.cursor(), out)
    assert n == 2  # (post1, color) 聚合成一行 + (post2, finish)

    import pyarrow.parquet as pq

    table = pq.read_table(out)
    rows = {(r["post_id"], r["dimension"]): r for r in table.to_pylist()}
    assert rows[(1, "color")]["value"] == 2
    assert rows[(1, "color")]["n_events"] == 2
    assert len(rows[(1, "color")]["embedding"]) == DIM


async def test_export_pairwise_skips_skip(db: DB, tmp_path) -> None:
    _seed_embeddings(db, [1, 2, 3])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_pairwise(post_a=1, post_b=2, dimension="color", winner="a", rubric_version="color-v1", session_id="s1")
    await repo.insert_pairwise(post_a=2, post_b=3, dimension="color", winner="skip", rubric_version="color-v1", session_id="s1")

    out = tmp_path / "pairwise.parquet"
    n = export_pairwise(db.cursor(), out)
    assert n == 1  # skip 不导出

    import pyarrow.parquet as pq

    rows = pq.read_table(out).to_pylist()
    assert rows[0]["winner"] == "a"
    assert len(rows[0]["embedding_a"]) == DIM
    assert len(rows[0]["embedding_b"]) == DIM
```

（若 `scripts/` 不在测试 import path 上，在测试文件顶部加：

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from export_annotations import export_absolute, export_pairwise
```
）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd E:/pictoria/server && uv run pytest tests/test_export_annotations.py -v`
Expected: FAIL — ImportError

- [ ] **Step 4: 写导出 CLI**（`scripts/export_annotations.py`，CLI 骨架模仿 `scripts/backfill_silva_scores.py`：sys.path 注入 + DB + run_migrations）

```python
"""Export annotation events to parquet for silva training.

Absolute events are aggregated latest-wins per (post_id, dimension) and joined with
SigLIP2 embeddings; pairwise events are exported one row per judgement (skip excluded).

    uv run python scripts/export_annotations.py --out-dir ../data/annotations          # both kinds
    uv run python scripts/export_annotations.py --kind absolute --out-dir ../data
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

SERVER_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from db import DB, run_migrations

MIGRATIONS_DIR = SERVER_ROOT / "migrations"
EMBEDDING_TABLE = "post_vectors_siglip2"


def _embedding_for(cur, post_id: int) -> list[float] | None:
    cur.execute(f"SELECT embedding FROM {EMBEDDING_TABLE} WHERE post_id = ?", [post_id])  # noqa: S608
    row = cur.fetchone()
    if row is None:
        return None
    return np.frombuffer(row[0], dtype=np.float32).tolist()


def export_absolute(cur, out_path: pathlib.Path) -> int:
    """Latest-wins per (post_id, dimension), join embedding. Returns row count."""
    cur.execute(
        """
        SELECT a.post_id, a.dimension, a.scale, a.value, a.rubric_version,
               (SELECT COUNT(*) FROM absolute_annotations c
                 WHERE c.post_id = a.post_id AND c.dimension = a.dimension) AS n_events
        FROM absolute_annotations a
        WHERE a.id = (SELECT MAX(b.id) FROM absolute_annotations b
                       WHERE b.post_id = a.post_id AND b.dimension = a.dimension)
        ORDER BY a.post_id, a.dimension
        """,
    )
    rows = cur.fetchall()
    records = {"embedding": [], "dimension": [], "scale": [], "value": [], "n_events": [], "rubric_version": [], "post_id": []}
    skipped = 0
    for post_id, dimension, scale, value, rubric_version, n_events in rows:
        emb = _embedding_for(cur, post_id)
        if emb is None:
            skipped += 1
            continue
        records["embedding"].append(emb)
        records["dimension"].append(dimension)
        records["scale"].append(scale)
        records["value"].append(value)
        records["n_events"].append(n_events)
        records["rubric_version"].append(rubric_version)
        records["post_id"].append(post_id)
    if skipped:
        print(f"[export_absolute] skipped {skipped} rows with no embedding")
    table = pa.table(records)
    pq.write_table(table, out_path)
    return table.num_rows


def export_pairwise(cur, out_path: pathlib.Path) -> int:
    """One row per non-skip pairwise judgement, embeddings for both sides."""
    cur.execute(
        """
        SELECT post_a, post_b, dimension, winner, rubric_version
        FROM pairwise_annotations
        WHERE winner != 'skip'
        ORDER BY id
        """,
    )
    rows = cur.fetchall()
    records = {"embedding_a": [], "embedding_b": [], "dimension": [], "winner": [], "rubric_version": [], "post_id_a": [], "post_id_b": []}
    skipped = 0
    for post_a, post_b, dimension, winner, rubric_version in rows:
        ea, eb = _embedding_for(cur, post_a), _embedding_for(cur, post_b)
        if ea is None or eb is None:
            skipped += 1
            continue
        records["embedding_a"].append(ea)
        records["embedding_b"].append(eb)
        records["dimension"].append(dimension)
        records["winner"].append(winner)
        records["rubric_version"].append(rubric_version)
        records["post_id_a"].append(post_a)
        records["post_id_b"].append(post_b)
    if skipped:
        print(f"[export_pairwise] skipped {skipped} rows with missing embeddings")
    table = pa.table(records)
    pq.write_table(table, out_path)
    return table.num_rows


def main() -> None:
    ap = argparse.ArgumentParser(description="Export annotation events to parquet.")
    ap.add_argument("--db", default=os.environ.get("DB_PATH", r"E:/pictoria/server/illustration/images/.pictoria/pictoria.sqlite"))
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--kind", choices=["absolute", "pairwise", "both"], default="both")
    args = ap.parse_args()

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    db = DB(pathlib.Path(args.db))
    try:
        run_migrations(db.raw, MIGRATIONS_DIR)
        cur = db.cursor()
        if args.kind in ("absolute", "both"):
            n = export_absolute(cur, out_dir / "annotations_absolute.parquet")
            print(f"absolute: {n} rows -> {out_dir / 'annotations_absolute.parquet'}")
        if args.kind in ("pairwise", "both"):
            n = export_pairwise(cur, out_dir / "annotations_pairwise.parquet")
            print(f"pairwise: {n} rows -> {out_dir / 'annotations_pairwise.parquet'}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd E:/pictoria/server && uv run pytest tests/test_export_annotations.py -v`
Expected: PASS（2 个测试）

- [ ] **Step 6: Lint + Commit**

```bash
cd E:/pictoria/server && uv run ruff check scripts tests
cd E:/pictoria && git add server/scripts/export_annotations.py server/tests/test_export_annotations.py server/pyproject.toml server/uv.lock
git commit -m "feat(scripts): export annotation events to parquet for silva training"
```

---

### Task 7: 前端 — genapi + 路由 + 队列选择页

**Files:**
- Modify: `E:/pictoria/web/src/main.ts`
- Create: `E:/pictoria/web/src/views/Annotate.vue`
- Regenerate: `E:/pictoria/web/src/api/*`（genapi）

- [ ] **Step 1: 重新生成 API client**（需要 server 在跑）

```bash
cd E:/pictoria/server && uv run ./src/app.py --target_dir ./illustration/images   # 后台启动
cd E:/pictoria/web && pnpm genapi
```

Expected: `src/api/sdk.gen.ts` 出现 `v2SubmitAbsolute` / `v2SubmitPairwise` / `v2SubmitContentFlag` / `v2PostHistory` / `v2CreateAbsolute` / `v2CreatePairwise` / `v2ListQueues` / `v2NextAbsolute` / `v2NextPairwise`（具体名字由 operation_id_creator 决定，生成后查看并在后续任务中按实际名字引用）。生成后停掉 server。

- [ ] **Step 2: 加路由**（`src/main.ts` 的 routes 数组追加）

```typescript
{ path: '/annotate', component: () => import('./views/Annotate.vue'), name: 'annotate' },
```

- [ ] **Step 3: 写队列选择页**（`src/views/Annotate.vue`）

```vue
<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { ref } from 'vue'
import { v2ListQueues } from '@/api'
import type { QueueSummaryPublic } from '@/api'
import AbsoluteAnnotationSession from '@/components/annotate/AbsoluteAnnotationSession.vue'
import PairwiseAnnotationSession from '@/components/annotate/PairwiseAnnotationSession.vue'

const activeQueue = ref<QueueSummaryPublic | null>(null)

const { data: queues, refetch } = useQuery({
  queryKey: ['annotation-queues'],
  queryFn: async () => (await v2ListQueues()).data ?? [],
})

function exitSession() {
  activeQueue.value = null
  refetch()
}
</script>

<template>
  <div class="h-full bg-bg text-fg">
    <AbsoluteAnnotationSession
      v-if="activeQueue && activeQueue.kind === 'absolute'"
      :queue="activeQueue"
      @exit="exitSession"
    />
    <PairwiseAnnotationSession
      v-else-if="activeQueue && activeQueue.kind === 'pairwise'"
      :queue="activeQueue"
      @exit="exitSession"
    />
    <div v-else class="mx-auto max-w-2xl p-6">
      <h1 class="text-lg font-medium mb-4">标注队列</h1>
      <div v-if="!queues?.length" class="text-fg-muted text-sm">
        暂无队列。用 silva 侧脚本生成并 POST /v2/annotation-queues/absolute 导入。
      </div>
      <button
        v-for="q in queues"
        :key="q.id"
        class="w-full p-border rounded-md p-3 mb-2 flex items-center justify-between text-left hover:bg-surface"
        @click="activeQueue = q"
      >
        <div>
          <div class="text-sm font-medium">{{ q.name }}</div>
          <div class="text-xs text-fg-muted">{{ q.kind }} · {{ q.dimensions.join(' / ') }}<template v-if="q.scale"> · {{ q.scale }} 级</template></div>
        </div>
        <div class="text-xs text-fg-muted">{{ q.done }} / {{ q.total }}</div>
      </button>
    </div>
  </div>
</template>
```

（此时两个 Session 组件还不存在——先建只含 `<template><div /></template>` 的占位文件让构建通过，Task 9/10 实现。）

- [ ] **Step 4: 构建验证**

Run: `cd E:/pictoria/web && pnpm build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
cd E:/pictoria && git add web/src/main.ts web/src/views/Annotate.vue web/src/api web/src/components/annotate
git commit -m "feat(web): /annotate route with queue picker"
```

---

### Task 8: useAnnotationKeymap（键位映射纯函数 + 测试）

**Files:**
- Create: `E:/pictoria/web/src/composables/useAnnotationKeymap.ts`
- Test: `E:/pictoria/web/src/test/useAnnotationKeymap.test.ts`

键位设计（spec §5）：第 i 个维度用键盘第 i 行的前 scale 个键；`0` = 题材 flag 循环；`Space` = 跳过整张图。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from 'vitest'
import { KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'

const DIMS = ['color', 'finish', 'composition']

describe('keyToChoice', () => {
  it('maps row keys to (dimension, value) within scale', () => {
    expect(keyToChoice('1', DIMS, 2)).toEqual({ dimension: 'color', value: 1 })
    expect(keyToChoice('2', DIMS, 2)).toEqual({ dimension: 'color', value: 2 })
    expect(keyToChoice('q', DIMS, 2)).toEqual({ dimension: 'finish', value: 1 })
    expect(keyToChoice('a', DIMS, 3)).toEqual({ dimension: 'composition', value: 1 })
    expect(keyToChoice('d', DIMS, 3)).toEqual({ dimension: 'composition', value: 3 })
  })

  it('rejects keys beyond scale', () => {
    expect(keyToChoice('3', DIMS, 2)).toBeNull() // scale=2 时第三档不存在
    expect(keyToChoice('5', DIMS, 3)).toBeNull()
  })

  it('rejects keys for rows beyond dimension count', () => {
    expect(keyToChoice('a', ['color'], 2)).toBeNull()
  })

  it('supports 5-scale single-dimension (legacy overall)', () => {
    expect(keyToChoice('5', ['overall'], 5)).toEqual({ dimension: 'overall', value: 5 })
  })

  it('exposes key rows for UI hints', () => {
    expect(KEY_ROWS[0][0]).toBe('1')
    expect(KEY_ROWS[1][0]).toBe('q')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:/pictoria/web && pnpm vitest run src/test/useAnnotationKeymap.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```typescript
/** Keyboard layout for the annotation flow: dimension i uses keyboard row i. */
export const KEY_ROWS: readonly string[][] = [
  ['1', '2', '3', '4', '5'],
  ['q', 'w', 'e', 'r', 't'],
  ['a', 's', 'd', 'f', 'g'],
  ['z', 'x', 'c', 'v', 'b'],
]

export interface KeyChoice { dimension: string, value: number }

export function keyToChoice(key: string, dimensions: string[], scale: number): KeyChoice | null {
  for (let row = 0; row < dimensions.length && row < KEY_ROWS.length; row++) {
    const idx = KEY_ROWS[row].indexOf(key)
    if (idx >= 0 && idx < scale) {
      return { dimension: dimensions[row], value: idx + 1 }
    }
  }
  return null
}

/** All keys the absolute annotator listens to, for onKeyStroke registration. */
export function activeKeys(dimensions: string[], scale: number): string[] {
  return dimensions.flatMap((_, row) => KEY_ROWS[row]?.slice(0, scale) ?? [])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd E:/pictoria/web && pnpm vitest run src/test/useAnnotationKeymap.test.ts`
Expected: PASS（5 个测试）

- [ ] **Step 5: Commit**

```bash
cd E:/pictoria && git add web/src/composables/useAnnotationKeymap.ts web/src/test/useAnnotationKeymap.test.ts
git commit -m "feat(web): annotation keymap (dimension rows x scale columns)"
```

---

### Task 9: AbsoluteAnnotationSession（模式 A：单图多维键盘流）

**Files:**
- Modify: `E:/pictoria/web/src/components/annotate/AbsoluteAnnotationSession.vue`（替换占位）

行为（spec §5 模式 A）：一屏一图；维度×档位按键选择；全维度选满 → 批量 POST + 标 done + 自动翻页；`0` 循环题材 flag；`Space` 跳过（仅标 done）；`Escape` 退出；不显示历史标注（防锚定）；per-dimension `elapsed_ms` 从图片展示起计。

- [ ] **Step 1: 实现组件**

```vue
<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextAbsolute, v2SubmitAbsolute, v2SubmitContentFlag } from '@/api'
import type { AbsoluteQueueItemPublic, QueueSummaryPublic } from '@/api'
import { activeKeys, KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

const props = defineProps<{ queue: QueueSummaryPublic }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const rubricVersions = computed(() => Object.fromEntries(props.queue.dimensions.map(d => [d, `${d}-v1`])))

const buffer = ref<AbsoluteQueueItemPublic[]>([])
const doneCount = ref(props.queue.done)
const exhausted = ref(false)
const current = computed(() => buffer.value[0] ?? null)

const choices = ref<Record<string, number>>({})
const flagState = ref<'none' | 'love' | 'hate'>('none')
let shownAt = performance.now()
const elapsed = ref<Record<string, number>>({})

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) { return }
  try {
    const resp = await v2NextAbsolute({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
    const items = resp.data ?? []
    const known = new Set(buffer.value.map(i => i.position))
    buffer.value.push(...items.filter(i => !known.has(i.position)))
    if (!items.length) { exhausted.value = true }
  }
  catch (err) { handleAPIError(err, '加载队列失败') }
}

function resetForNext() {
  choices.value = {}
  elapsed.value = {}
  flagState.value = 'none'
  shownAt = performance.now()
}

async function advance() {
  buffer.value.shift()
  doneCount.value += 1
  resetForNext()
  await refill()
}

async function submitAndAdvance() {
  const item = current.value
  if (!item) { return }
  try {
    await v2SubmitAbsolute({
      body: {
        events: props.queue.dimensions.map(d => ({
          post_id: item.post.id,
          dimension: d,
          scale: props.queue.scale!,
          value: choices.value[d],
          rubric_version: rubricVersions.value[d],
          session_id: sessionId,
          elapsed_ms: elapsed.value[d] ?? null,
        })),
        queue_id: props.queue.id,
        queue_position: item.position,
      },
    })
    await advance()
  }
  catch (err) { handleAPIError(err, '提交失败') }
}

// 维度×档位按键
onKeyStroke(activeKeys(props.queue.dimensions, props.queue.scale ?? 2), (e) => {
  if (!current.value) { return }
  e.preventDefault()
  const choice = keyToChoice(e.key, props.queue.dimensions, props.queue.scale ?? 2)
  if (!choice) { return }
  choices.value = { ...choices.value, [choice.dimension]: choice.value }
  elapsed.value = { ...elapsed.value, [choice.dimension]: Math.round(performance.now() - shownAt) }
  if (props.queue.dimensions.every(d => choices.value[d] != null)) {
    submitAndAdvance()
  }
})

// 0 = 题材 flag 循环（事件流：每次按键都记录，'none' 即撤销）
onKeyStroke('0', async (e) => {
  if (!current.value) { return }
  e.preventDefault()
  const next = flagState.value === 'none' ? 'love' : flagState.value === 'love' ? 'hate' : 'none'
  flagState.value = next
  try {
    await v2SubmitContentFlag({ body: { post_id: current.value.post.id, flag: next, session_id: sessionId } })
  }
  catch (err) { handleAPIError(err, 'flag 失败') }
})

// Space = 跳过整张图（仅标 done，不发事件）
onKeyStroke(' ', async (e) => {
  if (!current.value) { return }
  e.preventDefault()
  try {
    await v2SubmitAbsolute({ body: { events: [], queue_id: props.queue.id, queue_position: current.value.position } })
    await advance()
  }
  catch (err) { handleAPIError(err, '跳过失败') }
})

onKeyStroke('Escape', (e) => { e.preventDefault(); emit('exit') })

watch(() => props.queue.id, () => { buffer.value = []; exhausted.value = false; resetForNext(); refill() }, { immediate: true })

const SCALE_LABELS: Record<number, string[]> = {
  2: ['不好', '好'],
  3: ['差', '中', '好'],
  5: ['1', '2', '3', '4', '5'],
}
const labels = computed(() => SCALE_LABELS[props.queue.scale ?? 2])
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="px-3 py-2 p-divider flex items-center justify-between text-sm">
      <span>{{ queue.name }}</span>
      <span class="text-fg-muted">{{ doneCount }} / {{ queue.total }} · Esc 退出 · Space 跳过 · 0 题材flag<template v-if="flagState !== 'none'">（{{ flagState }}）</template></span>
    </div>

    <div v-if="current" class="flex-1 min-h-0 flex">
      <div class="flex-1 min-w-0 flex items-center justify-center bg-bg">
        <img
          :key="current.post.id"
          :src="getPostImageURL({ filePath: current.post.filePath, fileName: current.post.fileName, extension: current.post.extension, sha256: current.post.sha256 })"
          class="max-h-full max-w-full object-contain"
          decoding="async"
        >
      </div>
      <div class="w-56 shrink-0 p-3 p-border border-y-0 border-r-0 flex flex-col gap-3">
        <div v-for="(dim, row) in queue.dimensions" :key="dim">
          <div class="text-xs text-fg-muted mb-1">{{ dim }}</div>
          <div class="flex gap-1">
            <span
              v-for="(label, i) in labels"
              :key="i"
              class="px-2 py-1 rounded text-xs p-border"
              :class="choices[dim] === i + 1 ? 'bg-primary text-white border-primary' : 'text-fg-muted'"
            >
              <kbd class="mr-1 opacity-60">{{ KEY_ROWS[row][i] }}</kbd>{{ label }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="flex-1 flex items-center justify-center text-fg-muted text-sm">
      {{ exhausted ? '队列已全部完成 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
```

（生成的 SDK 函数名 / 类型字段名以 Task 7 genapi 实际输出为准——camelCase 响应字段（`post.filePath`）、snake_case 请求体字段（`post_id`），对不上时按 `types.gen.ts` 调整。）

- [ ] **Step 2: 构建 + 手动验证**

```bash
cd E:/pictoria/web && pnpm build && pnpm lint
```

手动验证（需要 server + web dev 各自跑起来）：

```bash
# 创建一个测试队列：
curl -X POST http://127.0.0.1:4777/v2/annotation-queues/absolute -H "Content-Type: application/json" -d '{"name":"smoke-test","dimensions":["color","finish","composition"],"scale":2,"post_ids":[<取库里真实存在的 3 个 post id>]}'
```

打开 `http://localhost:5173/annotate` → 选 smoke-test 队列 → 验证：按 `1/2`、`q/w`、`a/s` 三维选满自动翻页；`0` 循环 flag；`Space` 跳过；标完显示完成；DB 里 `SELECT * FROM absolute_annotations` 有事件且 `elapsed_ms` 非空。

- [ ] **Step 3: Commit**

```bash
cd E:/pictoria && git add web/src/components/annotate/AbsoluteAnnotationSession.vue
git commit -m "feat(web): absolute annotation session (single image, multi-dimension keyboard flow)"
```

---

### Task 10: PairwiseAnnotationSession（模式 B：双图选边）

**Files:**
- Modify: `E:/pictoria/web/src/components/annotate/PairwiseAnnotationSession.vue`（替换占位）

行为（spec §5 模式 B）：左右两图 + 顶部显示当前维度；`←/→` 选边、`↓` tie、`Space` skip（skip 也记录事件——跳过本身是信息）；提交即标 done 翻页。

- [ ] **Step 1: 实现组件**

```vue
<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { v2NextPairwise, v2SubmitPairwise } from '@/api'
import type { PairwiseQueueItemPublic, QueueSummaryPublic } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { getPostImageURL } from '@/utils'

const props = defineProps<{ queue: QueueSummaryPublic }>()
const emit = defineEmits<{ exit: [] }>()

const { handle: handleAPIError } = useAPIError()

const sessionId = crypto.randomUUID()
const dimension = computed(() => props.queue.dimensions[0])

const buffer = ref<PairwiseQueueItemPublic[]>([])
const doneCount = ref(props.queue.done)
const exhausted = ref(false)
const current = computed(() => buffer.value[0] ?? null)
let shownAt = performance.now()

async function refill() {
  if (exhausted.value || buffer.value.length >= 5) { return }
  try {
    const resp = await v2NextPairwise({ path: { queue_id: props.queue.id }, query: { limit: 20 } })
    const items = resp.data ?? []
    const known = new Set(buffer.value.map(i => i.position))
    buffer.value.push(...items.filter(i => !known.has(i.position)))
    if (!items.length) { exhausted.value = true }
  }
  catch (err) { handleAPIError(err, '加载队列失败') }
}

async function judge(winner: 'a' | 'b' | 'tie' | 'skip') {
  const item = current.value
  if (!item) { return }
  try {
    await v2SubmitPairwise({
      body: {
        post_a: item.postA.id,
        post_b: item.postB.id,
        dimension: dimension.value,
        winner,
        rubric_version: `${dimension.value}-v1`,
        session_id: sessionId,
        elapsed_ms: Math.round(performance.now() - shownAt),
        queue_id: props.queue.id,
        queue_position: item.position,
      },
    })
    buffer.value.shift()
    doneCount.value += 1
    shownAt = performance.now()
    await refill()
  }
  catch (err) { handleAPIError(err, '提交失败') }
}

onKeyStroke(['ArrowLeft', 'ArrowRight', 'ArrowDown', ' '], (e) => {
  if (!current.value) { return }
  e.preventDefault()
  const winner = e.key === 'ArrowLeft' ? 'a' : e.key === 'ArrowRight' ? 'b' : e.key === 'ArrowDown' ? 'tie' : 'skip'
  judge(winner)
})
onKeyStroke('Escape', (e) => { e.preventDefault(); emit('exit') })

watch(() => props.queue.id, () => { buffer.value = []; exhausted.value = false; shownAt = performance.now(); refill() }, { immediate: true })

function imgURL(p: { filePath: string, fileName: string, extension: string, sha256: string }) {
  return getPostImageURL(p)
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="px-3 py-2 p-divider flex items-center justify-between text-sm">
      <span>{{ queue.name }} · <b>{{ dimension }}</b> 哪边更好？</span>
      <span class="text-fg-muted">{{ doneCount }} / {{ queue.total }} · ← 左 · → 右 · ↓ 平 · Space 跳过 · Esc 退出</span>
    </div>

    <div v-if="current" class="flex-1 min-h-0 flex gap-1">
      <div class="flex-1 min-w-0 flex items-center justify-center bg-bg">
        <img :key="current.postA.id" :src="imgURL(current.postA)" class="max-h-full max-w-full object-contain" decoding="async">
      </div>
      <div class="flex-1 min-w-0 flex items-center justify-center bg-bg">
        <img :key="current.postB.id" :src="imgURL(current.postB)" class="max-h-full max-w-full object-contain" decoding="async">
      </div>
    </div>

    <div v-else class="flex-1 flex items-center justify-center text-fg-muted text-sm">
      {{ exhausted ? '队列已全部完成 🎉（Esc 返回）' : '加载中…' }}
    </div>
  </div>
</template>
```

- [ ] **Step 2: 构建 + 手动验证**

```bash
cd E:/pictoria/web && pnpm build && pnpm lint
```

手动验证：curl 创建 pairwise 队列（`POST /v2/annotation-queues/pairwise`，pairs 用库里真实 post id），`/annotate` 进入，验证 `←/→/↓/Space` 都记录事件且翻页，`SELECT * FROM pairwise_annotations` 确认 winner 值正确。

- [ ] **Step 3: Commit**

```bash
cd E:/pictoria && git add web/src/components/annotate/PairwiseAnnotationSession.vue
git commit -m "feat(web): pairwise annotation session (side-by-side pick)"
```

---

### Task 11: Post 详情页标注历史区块

**Files:**
- Create: `E:/pictoria/web/src/components/AnnotationHistory.vue`
- Modify: `E:/pictoria/web/src/components/PostDetailPanel.vue`（合适位置挂载，如 waifu score 区块之后）

- [ ] **Step 1: 实现组件**

```vue
<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2PostHistory } from '@/api'

const props = defineProps<{ postId: number }>()

const { data } = useQuery({
  queryKey: ['annotations', () => props.postId],
  queryFn: async () => (await v2PostHistory({ path: { post_id: props.postId } })).data,
})

const hasAny = computed(() => (data.value?.absolute?.length ?? 0) > 0 || (data.value?.pairwise?.length ?? 0) > 0 || data.value?.contentFlag)
</script>

<template>
  <div v-if="hasAny" class="p-divider pb-3">
    <div class="text-xs text-fg-muted mb-2">标注历史</div>
    <div v-if="data?.contentFlag" class="text-xs mb-1">题材：{{ data.contentFlag === 'love' ? '❤️ 喜欢' : '💢 讨厌' }}</div>
    <div v-for="a in data?.absolute" :key="`abs-${a.id}`" class="text-xs text-fg-muted flex justify-between">
      <span>{{ a.dimension }} = {{ a.value }}/{{ a.scale }}</span>
      <span>{{ a.createdAt.slice(0, 10) }}</span>
    </div>
    <div v-for="p in data?.pairwise" :key="`pw-${p.id}`" class="text-xs text-fg-muted flex justify-between">
      <span>{{ p.dimension }}: #{{ p.postA }} vs #{{ p.postB }} → {{ p.winner }}</span>
      <span>{{ p.createdAt.slice(0, 10) }}</span>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 挂载到 PostDetailPanel.vue**（打分区块之后）

```vue
<AnnotationHistory :post-id="post.id" />
```

（import 加到 script setup；具体插入位置看该文件现有区块顺序，放 waifu score 之后、tags 之前。）

- [ ] **Step 3: 构建 + 手动验证 + Commit**

```bash
cd E:/pictoria/web && pnpm build && pnpm lint
```

打开任一标过的 post 详情页，确认历史显示。

```bash
cd E:/pictoria && git add web/src/components/AnnotationHistory.vue web/src/components/PostDetailPanel.vue
git commit -m "feat(web): annotation history block in post detail panel"
```

---

### Task 12: 评分细则 v1 模板（silva repo）

**Files:**
- Create: `E:/code/silva/docs/rubrics/color.md`
- Create: `E:/code/silva/docs/rubrics/finish.md`
- Create: `E:/code/silva/docs/rubrics/composition.md`

细则内容只能由标注者本人填写（个人寡好），本任务交付**结构模板 + 已定稿的切点定义**，待填槽位明确标注 `（标注前必填）`。

- [ ] **Step 1: 写三个模板**（以 color.md 为例，finish/composition 同构，仅维度定义与 checklist 不同）

`E:/code/silva/docs/rubrics/color.md`：

```markdown
# 颜色（color）评分细则

**版本**: color-v1（事件表 rubric_version 引用此值；修订时 bump 至 color-v2 并保留旧文）

## 维度定义

色彩**运用**得好不好（合理性、品味）——不是丰富/鲜艳程度。
低饱和的图配色可以极高明；大红大紫可以很灾难。

**不属于本维度**：题材喜恶（忽略它，必要时按 0 打 flag）、完成度、画质。

## 切点（二元 scale=2）

- **2（好）**: 这张图的配色好到让我想收藏它。
- **1（不好）**: 达不到上一条。

## 三元切点（scale=3，形态实验用）

- **3（好）**: 配色让我想收藏。
- **2（中）**: 无功无过。
- **1（差）**: 配色脏/冲突/让我皱眉。

## 判断 checklist（标注前必填，5~10 条）

- （标注前必填：列出你判断配色好坏时实际在看的东西，例如「主色组是否和谐」「皮肤色是否通透」…）

## 边界案例（标注中持续追加）

- （遇到犹豫超过 5 秒的图，记一条："post #xxx — 犹豫原因 — 最终怎么判的"）
```

`finish.md` 的对应差异部分：

```markdown
# 完成度（finish）评分细则

**版本**: finish-v1

## 维度定义

sketch→精修的精修程度、细节装饰的精致度。

**不属于本维度**：纯格式问题（3koma、漫画分格——留给 danbooru tags）、配色品味、构图。

## 切点（二元 scale=2）

- **2（好）**: 精修完整，细节装饰让我想放大看。
- **1（不好）**: 草稿感/速涂感/完整但平。
```

`composition.md` 的对应差异部分：

```markdown
# 构图（composition）评分细则

**版本**: composition-v1

## 维度定义

广义演出：姿势动态、镜头角度、场景安排。不细分子轴——判断时综合，
但 checklist 按子轴列（姿势是否生硬？角度有没有想法？场景是否服务主体？）。

**不属于本维度**：画质、上色质量、完成度。

## 切点（二元 scale=2）

- **2（好）**: 演出有想法（动态/角度/布景任一出彩）。
- **1（不好）**: 站桩/呆板/常规证件照式构图。
```

（三个文件都含同样的「三元切点」「checklist（标注前必填）」「边界案例」小节，结构同 color.md。）

- [ ] **Step 2: Commit（silva repo）**

```bash
cd E:/code/silva && git add docs/rubrics
git commit -m "docs(rubrics): v1 rubric templates for color/finish/composition"
```

---

## 验收清单（P0 完成定义）

1. `cd E:/pictoria/server && uv run pytest` 全绿。
2. `cd E:/pictoria/web && pnpm test -- --run && pnpm build` 全绿。
3. 手动冒烟（Task 9/10 的验证步骤）：absolute 三维标注 + pairwise 选边各跑通一条，事件落库、队列 done 递增、详情页可见历史。
4. `uv run python scripts/export_annotations.py --out-dir /tmp/ann --kind both` 产出两个 parquet，列符合 spec §7。
5. 三个细则模板就位，checklist 槽位待用户填写（这是 P1 形态实验的前置条件）。

## 后续（不在本计划）

- P1 形态对比实验：silva 侧采样 200 张 → 三种队列导入 → 标注 → `intra_rater.py` 风格分析（speed/kappa/增益）。
- P2+ 冷启动队列生成脚本（silva `scripts/make_queue_coldstart.py`）、多头训练、OOF 循环、全库回填——见 spec §8/§11。
```
