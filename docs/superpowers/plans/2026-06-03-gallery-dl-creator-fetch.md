# gallery-dl 按创作者抓取存档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 gallery-dl 作为多站点 metadata 提取器，按 `creators.txt` 清单批量抓取 Booru / Kemono 图片到本地图库，原生 tag 映射进五类 canonical group，全程零落盘 sidecar。

**Architecture:** 一个独立脚本 `scripts/fetch_creators.py`（driver，沿用现有 scripts 骨架）读清单，逐 URL 调 `src/services/gallery_dl_import.py` 的编排函数；后者 subprocess 调 `gallery-dl -j`（metadata → stdout → 内存），过滤 + DB 去重后用 httpx 自己下载图片到 `target_dir/<category>/<creator>/`，再复用 `danbooru_import` 的事务骨架把 posts/tags 写库。`source` 走一个新的共享工具函数 `utils.resolve_source`（同时修正现有 danbooru import）。

**Tech Stack:** Python 3.12 / gallery-dl(subprocess CLI)/ httpx / SQLite + sqlite-vec / pytest + pytest-asyncio。

**所有命令从 `server/` 目录运行**（`app.py` 等都假设 cwd=server）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `server/pyproject.toml` | 加 `gallery-dl` 运行时依赖 | Modify |
| `server/src/utils.py` | 新增 `resolve_source` 纯工具函数 | Modify |
| `server/src/services/danbooru_import.py` | source 改用 `resolve_source` | Modify |
| `server/src/services/gallery_dl_import.py` | 核心：subprocess 取 metadata / 解析 / tag 映射 / 下载 / 入库编排 | Create |
| `server/scripts/fetch_creators.py` | driver：读清单 + argparse + 逐 URL 调用 + 汇总 | Create |
| `server/creators.txt.example` | 清单样例 | Create |
| `server/.gitignore`（或仓库根 `.gitignore`） | 忽略 `creators.txt` / `gallery-dl.conf` | Modify |
| `server/tests/test_gallery_dl_import.py` | 单测纯函数 + 编排（mock subprocess/网络，db fixture） | Create |
| `server/tests/fixtures/gallerydl_gelbooru.json` | 真实 `gallery-dl -j` 样本（Booru） | Create |
| `server/tests/fixtures/gallerydl_kemono.json` | 真实 `gallery-dl -j` 样本（Kemono） | Create |

---

## Task 1: 添加 gallery-dl 依赖

**Files:**
- Modify: `server/pyproject.toml:6-34`（`dependencies` 列表）

- [ ] **Step 1: 加依赖并锁定**

Run（在 `server/`）:
```bash
uv add gallery-dl
```
Expected: `pyproject.toml` 的 `dependencies` 末尾新增 `"gallery-dl>=1.27.0"`（具体版本以解析为准），`uv.lock` 更新。

- [ ] **Step 2: 验证可执行**

Run:
```bash
uv run gallery-dl --version
```
Expected: 打印版本号（如 `1.27.x`），退出码 0。

- [ ] **Step 3: Commit**

```bash
git add server/pyproject.toml server/uv.lock
git commit -m "chore(deps): add gallery-dl for creator archiving"
```

---

## Task 2: `resolve_source` 工具函数 + 修正 danbooru import

`source` 统一原则：登记来源优先，空缺回退站点页。抽成纯函数，danbooru 与 gallery-dl 共用。

**Files:**
- Create: `server/tests/test_gallery_dl_import.py`
- Modify: `server/src/utils.py`（新增函数，放在 `from_rating_to_int` 之后，约 `:301`）
- Modify: `server/src/services/danbooru_import.py:243`（INSERT 的 source 实参）

- [ ] **Step 1: Write the failing test**

新建 `server/tests/test_gallery_dl_import.py`：
```python
"""Unit tests for the gallery-dl import workflow's pure pieces + orchestration."""

from __future__ import annotations

from utils import resolve_source


def test_resolve_source_prefers_registered_source() -> None:
    assert resolve_source("https://pixiv.net/artworks/1", "https://gelbooru.com/x") \
        == "https://pixiv.net/artworks/1"


def test_resolve_source_falls_back_on_empty_string() -> None:
    assert resolve_source("", "https://gelbooru.com/x") == "https://gelbooru.com/x"


def test_resolve_source_falls_back_on_none() -> None:
    assert resolve_source(None, "https://gelbooru.com/x") == "https://gelbooru.com/x"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_source' from 'utils'`.

- [ ] **Step 3: Write minimal implementation**

在 `server/src/utils.py` 的 `from_rating_to_int` 函数之后新增：
```python
def resolve_source(raw_source: str | None, fallback_url: str) -> str:
    """Prefer the metadata-registered original source; fall back to the site page.

    Booru/Danbooru leave an empty string when a post has no upstream source, so
    `or` correctly routes both "" and None to the fallback.
    """
    return raw_source or fallback_url
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -v`
Expected: PASS（3 passed）。

- [ ] **Step 5: 修正 danbooru import 使用它**

在 `server/src/services/danbooru_import.py` 顶部 import 处加入（与现有 `from utils import from_rating_to_int, logger` 合并）：
```python
from utils import from_rating_to_int, logger, resolve_source
```
把 `_insert_posts_and_links_tx`（约 `:243`）中这一行：
```python
            f"https://danbooru.donmai.us/posts/{d_post.id}",
```
改为：
```python
            resolve_source(d_post.source, f"https://danbooru.donmai.us/posts/{d_post.id}"),
```

- [ ] **Step 6: Write the danbooru source characterization test**

在 `server/tests/test_gallery_dl_import.py` 追加（`db` fixture 来自 `conftest.py`，自动可用）：
```python
from types import SimpleNamespace

from services.danbooru_import import _insert_posts_and_links_tx


def test_danbooru_insert_uses_registered_source_then_falls_back(db) -> None:
    cur = db.cursor()
    with_src = SimpleNamespace(id=111, file_ext="jpg", source="https://pixiv.net/i/111",
                               rating="general", created_at="2026-01-01 00:00:00+00:00")
    without_src = SimpleNamespace(id=222, file_ext="png", source="",
                                  rating="general", created_at="2026-01-01 00:00:00+00:00")
    _insert_posts_and_links_tx(cur, "danbooru/test", [with_src, without_src], [{}, {}])

    cur.execute("SELECT source FROM posts WHERE file_name = '111'")
    assert cur.fetchone()[0] == "https://pixiv.net/i/111"
    cur.execute("SELECT source FROM posts WHERE file_name = '222'")
    assert cur.fetchone()[0] == "https://danbooru.donmai.us/posts/222"
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `uv run pytest tests/test_gallery_dl_import.py -v`
Expected: PASS（5 passed）。

- [ ] **Step 8: Commit**

```bash
git add server/src/utils.py server/src/services/danbooru_import.py server/tests/test_gallery_dl_import.py
git commit -m "fix(danbooru): keep registered source, fall back to post page"
```

---

## Task 3: 获取真实 `gallery-dl -j` 样本（前置调研）

`-j` 的顶层结构与字段名随 extractor 而异，必须用真实输出校准后续解析。本任务产出两个 fixture 文件并记录结构。

**Files:**
- Create: `server/tests/fixtures/gallerydl_gelbooru.json`
- Create: `server/tests/fixtures/gallerydl_kemono.json`

- [ ] **Step 1: 抓 Booru 样本**

Run（挑一个返回少量结果的 artist tag）:
```bash
uv run gallery-dl -j "https://gelbooru.com/index.php?page=post&s=list&tags=hews" > tests/fixtures/gallerydl_gelbooru.json
```
若无网络/被限：手工构造一个最小样本（见 Step 3 的结构说明），并在文件首行加注释行 `// SYNTHETIC — replace with real output`。

- [ ] **Step 2: 抓 Kemono 样本**

Run:
```bash
uv run gallery-dl -j "https://kemono.cr/patreon/user/<某个公开creator>" > tests/fixtures/gallerydl_kemono.json
```
失败（CF/403）则同样手工构造最小样本。

- [ ] **Step 3: 记录确认到的结构（写进本计划下方 Task 4/5 的代码注释）**

`gallery-dl -j` 输出形如一个 JSON 数组，元素是 message：`[type, url, kwdict]`，其中 `type==3` 表示一个待下载文件（`url` 是直链，`kwdict` 是该文件的 metadata）。**核对并记录**：
- type 数值（应为 `3`）；
- Booru 的 tag 字段名：预期 `tags_artist` / `tags_character` / `tags_copyright` / `tags_general` / `tags_metadata`（gelbooru）；**moebooru（yande.re/konachan）可能只有扁平 `tags`**；
- `extension`、`filename`、`id`、`rating`（s/q/e 还是 general/...）、`source`、`date`/`created_at` 字段名；
- Kemono：`category`（应为 `kemono`）、`user`/`username`、`source`/原帖字段、tag 基本缺失。

把和下方代码假设不一致的字段名，在 Task 4/5 实现时按此调整。

- [ ] **Step 4: Commit**

```bash
git add server/tests/fixtures/gallerydl_gelbooru.json server/tests/fixtures/gallerydl_kemono.json
git commit -m "test(gallery-dl): capture real -j metadata fixtures"
```

---

## Task 4: `run_gallery_dl_json` — subprocess 取 metadata

把最不确定的「message 包装解析」隔离在这一个函数：返回 `(download_url, kwdict)` 列表。

**Files:**
- Create: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

在 `test_gallery_dl_import.py` 追加：
```python
import json
import subprocess

from services import gallery_dl_import as gdl


def test_run_gallery_dl_json_extracts_url_message(monkeypatch) -> None:
    # type==3 => Url message: [3, "<download url>", {kwdict}]
    fake_stdout = json.dumps([
        [2, {"category": "gelbooru"}],                       # Directory msg — ignored
        [3, "https://img/1.jpg", {"id": 1, "extension": "jpg"}],
        [3, "https://img/2.png", {"id": 2, "extension": "png"}],
    ])
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout=fake_stdout, stderr=""))
    out = gdl.run_gallery_dl_json("https://gelbooru.com/x")
    assert out == [
        ("https://img/1.jpg", {"id": 1, "extension": "jpg"}),
        ("https://img/2.png", {"id": 2, "extension": "png"}),
    ]


def test_run_gallery_dl_json_returns_empty_on_nonzero_exit(monkeypatch) -> None:
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 1, stdout="", stderr="403 Forbidden"))
    assert gdl.run_gallery_dl_json("https://kemono.cr/x") == []


def test_run_gallery_dl_json_returns_empty_on_garbage(monkeypatch) -> None:
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout="not json", stderr=""))
    assert gdl.run_gallery_dl_json("https://gelbooru.com/x") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k run_gallery_dl_json -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.gallery_dl_import'`.

- [ ] **Step 3: Write minimal implementation**

新建 `server/src/services/gallery_dl_import.py`：
```python
"""Fetch a creator/tag page's metadata via gallery-dl, download images, persist.

gallery-dl is used purely as a multi-site metadata extractor: `gallery-dl -j`
dumps every entry's metadata to stdout (nothing written to disk). We filter to
images, dedupe against the DB, download the new ones ourselves (httpx, into
target_dir/<category>/<creator>/), then persist posts + tags reusing the
danbooru_import transaction skeleton. See
docs/superpowers/specs/2026-06-03-gallery-dl-creator-fetch-design.md.
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING, Any

from utils import logger

if TYPE_CHECKING:
    from collections.abc import Sequence

# gallery-dl message type for "a downloadable file" (url + metadata). Confirmed
# against real -j output in Task 3; adjust if the captured fixtures differ.
_MSG_URL = 3


def run_gallery_dl_json(url: str, *, config_path: str | None = None) -> list[tuple[str, dict[str, Any]]]:
    """Run `gallery-dl -j <url>` and return [(download_url, metadata), ...].

    Never raises: a non-zero exit (CF 403, bad URL) or unparseable stdout logs a
    warning and yields [] so the driver can continue to the next creator.
    """
    cmd = ["gallery-dl", "-j"]
    if config_path:
        cmd += ["--config", config_path]
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)  # noqa: S603
    except FileNotFoundError:
        logger.error("gallery-dl not found on PATH; is it installed?")
        return []
    if proc.returncode != 0:
        logger.warning(f"gallery-dl failed for {url} (exit {proc.returncode}): {proc.stderr.strip()[:200]}")
        return []
    try:
        messages = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning(f"gallery-dl produced unparseable JSON for {url}: {exc}")
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for msg in messages:
        if isinstance(msg, list) and len(msg) >= 3 and msg[0] == _MSG_URL:
            out.append((msg[1], msg[2]))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k run_gallery_dl_json -v`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): run -j subprocess and extract file metadata"
```

---

## Task 5: `GalleryDLItem` + `parse_entry`

把一个 `(download_url, metadata)` 规整成内部结构；非图片 → None。

**Files:**
- Modify: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

追加：
```python
def test_parse_entry_booru_extracts_fields() -> None:
    url = "https://files/1.jpg"
    meta = {
        "category": "gelbooru", "id": 1, "filename": "abc1", "extension": "jpg",
        "rating": "general", "source": "https://pixiv.net/i/9",
        "date": "2026-01-02 03:04:05",
        "tags_artist": "hews", "tags_character": "rin", "tags_copyright": "vocaloid",
        "tags_general": "1girl solo", "tags_metadata": "highres",
        "search_tags": "hews",
    }
    item = gdl.parse_entry(url, meta, fallback_url="https://gelbooru.com/post/1")
    assert item is not None
    assert item.download_url == "https://files/1.jpg"
    assert item.extension == "jpg"
    assert item.file_name == "abc1"
    assert item.category == "gelbooru"
    assert item.source == "https://pixiv.net/i/9"
    assert item.rating == 1  # from_rating_to_int("general")
    assert item.tags_by_category["artist"] == ["hews"]
    assert item.tags_by_category["general"] == ["1girl", "solo"]
    assert item.tags_by_category["meta"] == ["highres"]


def test_parse_entry_skips_non_image() -> None:
    meta = {"category": "kemono", "id": 9, "extension": "zip"}
    assert gdl.parse_entry("https://f/9.zip", meta, fallback_url="x") is None


def test_parse_entry_kemono_has_empty_tags_and_fallback_source() -> None:
    meta = {"category": "kemono", "id": "p1", "filename": "p1", "extension": "png",
            "username": "alice"}
    item = gdl.parse_entry("https://f/p1.png", meta, fallback_url="https://kemono.cr/x")
    assert item is not None
    assert item.tags_by_category == {}
    assert item.source == "https://kemono.cr/x"  # no registered source
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k parse_entry -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'parse_entry'`.

- [ ] **Step 3: Write minimal implementation**

在 `gallery_dl_import.py` 顶部加 import：
```python
from dataclasses import dataclass, field

from services.danbooru_import import SUPPORTED_IMAGE_EXTS
from utils import from_rating_to_int, logger, resolve_source
```
（删掉原先单独的 `from utils import logger`，合并到上面一行。）

加数据类 + 函数：
```python
# Booru tag-field name (in gallery-dl metadata) -> our canonical group name.
# Confirmed in Task 3; moebooru (yande.re/konachan) may only have flat "tags",
# which then all land under "general".
_BOORU_TAG_FIELDS: dict[str, str] = {
    "tags_artist": "artist",
    "tags_character": "character",
    "tags_copyright": "copyright",
    "tags_general": "general",
    "tags_metadata": "meta",
}


@dataclass
class GalleryDLItem:
    download_url: str
    file_name: str                                # posts.file_name (no extension)
    extension: str                                # lowercase, no dot
    source: str                                   # resolved (registered or fallback)
    category: str                                 # gallery-dl category
    creator: str                                  # artist tag / user id -> directory
    rating: int                                   # from_rating_to_int
    published_at: str | None
    tags_by_category: dict[str, list[str]] = field(default_factory=dict)


def parse_entry(download_url: str, meta: dict, *, fallback_url: str) -> GalleryDLItem | None:
    """Normalise one (url, metadata) into a GalleryDLItem; non-image -> None."""
    ext = str(meta.get("extension", "")).lower().lstrip(".")
    if ext not in SUPPORTED_IMAGE_EXTS:
        return None
    file_name = str(meta.get("filename") or meta.get("id") or "").strip()
    if not file_name:
        return None

    tags_by_category: dict[str, list[str]] = {}
    for meta_field, group in _BOORU_TAG_FIELDS.items():
        raw = meta.get(meta_field)
        if raw:
            tags_by_category[group] = str(raw).split()

    rating_raw = meta.get("rating")
    rating = from_rating_to_int(rating_raw) if isinstance(rating_raw, str) else 0

    creator = str(
        meta.get("search_tags") or meta.get("username") or meta.get("user") or "misc",
    ).strip() or "misc"

    return GalleryDLItem(
        download_url=download_url,
        file_name=file_name,
        extension=ext,
        source=resolve_source(meta.get("source"), fallback_url),
        category=str(meta.get("category", "misc")),
        creator=creator,
        rating=rating,
        published_at=meta.get("date") or meta.get("created_at"),
        tags_by_category=tags_by_category,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k parse_entry -v`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): parse metadata entries into GalleryDLItem"
```

---

## Task 6: `build_tag_to_group` — 映射进 canonical group id

**Files:**
- Modify: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

追加：
```python
def _item(**kw):
    base = dict(download_url="u", file_name="f", extension="jpg", source="s",
                category="gelbooru", creator="hews", rating=0, published_at=None,
                tags_by_category={})
    base.update(kw)
    return gdl.GalleryDLItem(**base)


def test_build_tag_to_group_maps_each_category() -> None:
    item = _item(tags_by_category={"artist": ["hews"], "general": ["1girl", "solo"],
                                   "meta": ["highres"]})
    type_to_group = {"artist": 1, "character": 2, "copyright": 3, "general": 4, "meta": 5}
    assert gdl.build_tag_to_group(item, type_to_group) == {
        "hews": 1, "1girl": 4, "solo": 4, "highres": 5,
    }


def test_build_tag_to_group_empty_for_kemono() -> None:
    type_to_group = {"artist": 1, "general": 4}
    assert gdl.build_tag_to_group(_item(tags_by_category={}), type_to_group) == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k build_tag_to_group -v`
Expected: FAIL — no attribute `build_tag_to_group`.

- [ ] **Step 3: Write minimal implementation**

加：
```python
def build_tag_to_group(item: GalleryDLItem, type_to_group_id: dict[str, int]) -> dict[str, int]:
    """Flatten the item's per-category tags into {tag_name: group_id}.

    Tags whose category isn't in type_to_group_id are dropped (shouldn't happen
    with the five canonical groups). Kemono items carry no categorised tags, so
    this returns {} and auto-tagging fills them in later.
    """
    out: dict[str, int] = {}
    for group_name, names in item.tags_by_category.items():
        gid = type_to_group_id.get(group_name)
        if gid is None:
            continue
        for name in names:
            out.setdefault(name, gid)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k build_tag_to_group -v`
Expected: PASS（2 passed）。

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): map per-category tags to canonical group ids"
```

---

## Task 7: `download_items` — httpx 并发下载

**Files:**
- Modify: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

追加：
```python
def test_download_items_writes_files(tmp_path, monkeypatch) -> None:
    class FakeResp:
        content = b"\x89PNG\r\n"
        def raise_for_status(self): return None
    monkeypatch.setattr(gdl.httpx, "get", lambda *a, **k: FakeResp())

    items = [_item(download_url="https://f/1.jpg", file_name="1", extension="jpg"),
             _item(download_url="https://f/2.png", file_name="2", extension="png")]
    stats = gdl.download_items(items, tmp_path)

    assert (tmp_path / "1.jpg").read_bytes() == b"\x89PNG\r\n"
    assert (tmp_path / "2.png").exists()
    assert stats == {"downloaded": 2, "failed": 0}


def test_download_items_counts_failures(tmp_path, monkeypatch) -> None:
    def boom(*a, **k): raise RuntimeError("network")
    monkeypatch.setattr(gdl.httpx, "get", boom)
    stats = gdl.download_items([_item(download_url="https://f/1.jpg", file_name="1",
                                      extension="jpg")], tmp_path)
    assert stats == {"downloaded": 0, "failed": 1}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k download_items -v`
Expected: FAIL — no attribute `download_items` (and `httpx` not imported yet).

- [ ] **Step 3: Write minimal implementation**

在 `gallery_dl_import.py` 顶部 import 加：
```python
import concurrent.futures
from pathlib import Path

import httpx
```
加函数：
```python
# Mirror danbooru's downloader: a curl-ish UA gets past naive UA blocks.
_DL_HEADERS = {"User-Agent": "curl/8.5.0"}


def download_items(
    items: Sequence[GalleryDLItem],
    save_dir: Path,
    *,
    headers: dict[str, str] | None = None,
    n_worker: int = 16,
) -> dict[str, int]:
    """Download each item's direct URL into save_dir/<file_name>.<extension>.

    headers lets Kemono pass cookies/UA from gallery-dl.conf; defaults to a
    curl UA (enough for Booru CDNs). Returns {"downloaded": N, "failed": M}.
    """
    save_dir.mkdir(parents=True, exist_ok=True)
    hdrs = {**_DL_HEADERS, **(headers or {})}
    stats = {"downloaded": 0, "failed": 0}

    def _one(item: GalleryDLItem) -> bool:
        target = save_dir / f"{item.file_name}.{item.extension}"
        resp = httpx.get(item.download_url, headers=hdrs, follow_redirects=True, timeout=60.0)
        resp.raise_for_status()
        target.write_bytes(resp.content)
        return True

    with concurrent.futures.ThreadPoolExecutor(max_workers=n_worker) as ex:
        futures = [ex.submit(_one, it) for it in items]
        for fut in concurrent.futures.as_completed(futures):
            try:
                fut.result()
                stats["downloaded"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"gallery-dl download failed: {exc}")
                stats["failed"] += 1
    return stats
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k download_items -v`
Expected: PASS（2 passed）。

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): concurrent httpx downloader for items"
```

---

## Task 8: `_persist_gallery_items` — 入库事务

复用 danbooru 的 `_insert_tags_tx` / `_run_with_retry`，posts INSERT 仿 `_insert_posts_and_links_tx` 但用 GalleryDLItem。

**Files:**
- Modify: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

追加（用 `db` fixture）：
```python
def test_persist_gallery_items_writes_posts_and_tags(db) -> None:
    cur = db.cursor()
    type_to_group = {"artist": 1, "general": 2}  # ids from conftest seed
    items = [_item(file_name="g1", extension="jpg", source="https://pixiv.net/i/1",
                   rating=2, published_at="2026-03-03 00:00:00+00:00",
                   tags_by_category={"artist": ["artist_a"], "general": ["tag_general"]})]
    gdl._persist_gallery_items(db, "gelbooru/hews", items, type_to_group)

    cur.execute("SELECT extension, source, rating, published_at FROM posts WHERE file_name='g1'")
    row = cur.fetchone()
    assert row == ("jpg", "https://pixiv.net/i/1", 2, "2026-03-03 00:00:00+00:00")
    cur.execute("SELECT tag_name FROM post_has_tag pht "
                "JOIN posts p ON p.id = pht.post_id WHERE p.file_name='g1' ORDER BY tag_name")
    assert [r[0] for r in cur.fetchall()] == ["artist_a", "tag_general"]
```
> 注：测试用 conftest 已 seed 的 tag(`artist_a`/`tag_general`)与 group id（artist=1, general=2），避免依赖 canonical-group upsert。

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k persist_gallery_items -v`
Expected: FAIL — no attribute `_persist_gallery_items`.

- [ ] **Step 3: Write minimal implementation**

import 加：
```python
from services.danbooru_import import (
    SUPPORTED_IMAGE_EXTS,
    _insert_tags_tx,
    _run_with_retry,
)
```
（与 Task 5 的 `from services.danbooru_import import SUPPORTED_IMAGE_EXTS` 合并成上面这一组。）

加函数：
```python
def _persist_gallery_items(
    db: Any,
    file_path: str,
    items: Sequence[GalleryDLItem],
    type_to_group_id: dict[str, int],
) -> None:
    """Persist items + tags in two transactions, mirroring danbooru_import."""
    if not items:
        return
    tag_maps = [build_tag_to_group(it, type_to_group_id) for it in items]
    cur = db.cursor()
    try:
        all_tags: dict[str, int] = {}
        for tm in tag_maps:
            for name, gid in tm.items():
                all_tags.setdefault(name, gid)
        if all_tags:
            _run_with_retry(cur, "tags", lambda: _insert_tags_tx(cur, all_tags))
        _run_with_retry(cur, "posts", lambda: _insert_gallery_posts_tx(cur, file_path, items, tag_maps))
    finally:
        cur.close()


def _insert_gallery_posts_tx(
    cur: Any,
    file_path: str,
    items: Sequence[GalleryDLItem],
    tag_maps: Sequence[dict[str, int]],
) -> None:
    cur.execute("BEGIN")
    post_tag_pairs: list[tuple[int, dict[str, int]]] = []
    for item, tag_map in zip(items, tag_maps, strict=True):
        cur.execute(
            """
            INSERT INTO posts(file_path, file_name, extension, source, rating, published_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (file_path, file_name, extension)
            DO UPDATE SET source = excluded.source,
                          published_at = excluded.published_at,
                          updated_at = CURRENT_TIMESTAMP
            RETURNING id
            """,
            [file_path, item.file_name, item.extension, item.source, item.rating, item.published_at],
        )
        row = cur.fetchone()
        if row:
            post_tag_pairs.append((int(row[0]), tag_map))
    post_tag_rows = [(pid, name) for pid, tm in post_tag_pairs for name in tm]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) "
            "ON CONFLICT DO NOTHING",
            post_tag_rows,
        )
    cur.execute("COMMIT")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k persist_gallery_items -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): persist items + tags via danbooru tx skeleton"
```

---

## Task 9: `import_from_url` — 编排

串起 `-j` → parse → 过滤 → DB 去重 → (apply: 下载 + 入库)。

**Files:**
- Modify: `server/src/services/gallery_dl_import.py`
- Test: `server/tests/test_gallery_dl_import.py`

- [ ] **Step 1: Write the failing test**

追加：
```python
from dataclasses import dataclass as _dc


def test_import_from_url_dry_run_does_not_write(db, monkeypatch, tmp_path) -> None:
    import shared
    monkeypatch.setattr(shared, "target_dir", tmp_path)
    monkeypatch.setattr(gdl, "run_gallery_dl_json", lambda url, **k: [
        ("https://f/g1.jpg", {"category": "gelbooru", "id": "g1", "filename": "g1",
                               "extension": "jpg", "search_tags": "hews", "rating": "general"}),
    ])
    called = {"downloaded": False}
    monkeypatch.setattr(gdl, "download_items", lambda *a, **k: called.__setitem__("downloaded", True) or {})

    stats = gdl.import_from_url("https://gelbooru.com/x", db=db,
                                type_to_group_id={"artist": 1, "general": 2}, apply=False)
    assert stats.new == 1
    assert called["downloaded"] is False
    db.cursor().execute("SELECT COUNT(*) FROM posts WHERE file_path='gelbooru/hews'")
    assert db.cursor().execute("SELECT COUNT(*) FROM posts WHERE file_name='g1'").fetchone()[0] == 0


def test_import_from_url_apply_downloads_and_persists(db, monkeypatch, tmp_path) -> None:
    import shared
    monkeypatch.setattr(shared, "target_dir", tmp_path)
    monkeypatch.setattr(gdl, "run_gallery_dl_json", lambda url, **k: [
        ("https://f/g1.jpg", {"category": "gelbooru", "id": "g1", "filename": "g1",
                               "extension": "jpg", "search_tags": "hews", "rating": "general",
                               "source": "https://pixiv.net/i/1"}),
    ])
    monkeypatch.setattr(gdl, "download_items", lambda items, save_dir, **k: {"downloaded": len(items), "failed": 0})

    stats = gdl.import_from_url("https://gelbooru.com/x", db=db,
                                type_to_group_id={"artist": 1, "general": 2}, apply=True)
    assert stats.new == 1 and stats.downloaded == 1
    row = db.cursor().execute("SELECT file_path, source FROM posts WHERE file_name='g1'").fetchone()
    assert row == ("gelbooru/hews", "https://pixiv.net/i/1")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k import_from_url -v`
Expected: FAIL — no attribute `import_from_url`.

- [ ] **Step 3: Write minimal implementation**

import 加 `import shared`（放 import 区）。加 stats dataclass + 函数：
```python
@dataclass
class GalleryDLStats:
    fetched: int = 0       # entries from -j
    images: int = 0        # after image filter
    new: int = 0           # after DB dedupe
    downloaded: int = 0
    failed: int = 0


def import_from_url(
    url: str,
    *,
    db: Any,
    type_to_group_id: dict[str, int],
    apply: bool,
    config_path: str | None = None,
) -> GalleryDLStats:
    """Fetch -> parse -> filter -> dedupe -> (apply: download + persist)."""
    import shared  # noqa: PLC0415  # avoid import cycle at module load

    raw = run_gallery_dl_json(url, config_path=config_path)
    stats = GalleryDLStats(fetched=len(raw))
    items: list[GalleryDLItem] = []
    for dl_url, meta in raw:
        it = parse_entry(dl_url, meta, fallback_url=url)
        if it is not None:
            items.append(it)
    stats.images = len(items)
    if not items:
        return stats

    # All items from one URL share category/creator -> one file_path dir.
    file_path = f"{items[0].category}/{items[0].creator}"

    cur = db.cursor()
    try:
        cur.execute("SELECT file_name FROM posts WHERE file_path = ?", [file_path])
        existing = {r[0] for r in cur.fetchall()}
    finally:
        cur.close()
    new_items = [it for it in items if it.file_name not in existing]
    stats.new = len(new_items)
    if not new_items or not apply:
        return stats

    save_dir = shared.target_dir / file_path
    headers = None  # gallery-dl.conf cookies handled in -j; direct DL uses default UA
    dl_stats = download_items(new_items, save_dir, headers=headers)
    stats.downloaded = dl_stats.get("downloaded", 0)
    stats.failed = dl_stats.get("failed", 0)
    _persist_gallery_items(db, file_path, new_items, type_to_group_id)
    return stats
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k import_from_url -v`
Expected: PASS（2 passed）。

- [ ] **Step 5: Run the whole module test + lint**

Run:
```bash
uv run pytest tests/test_gallery_dl_import.py -v
uv run ruff check src/services/gallery_dl_import.py
```
Expected: 全 PASS；ruff 无错误（按提示修 import 顺序等）。

- [ ] **Step 6: Commit**

```bash
git add server/src/services/gallery_dl_import.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): orchestrate fetch/dedupe/download/persist per url"
```

---

## Task 10: driver 脚本 `fetch_creators.py`

**Files:**
- Create: `server/scripts/fetch_creators.py`
- Test: `server/tests/test_gallery_dl_import.py`（仅测纯函数 `parse_creators_file`）

- [ ] **Step 1: Write the failing test**

追加：
```python
def test_parse_creators_file_strips_comments_and_blanks() -> None:
    from scripts.fetch_creators import parse_creators_file  # noqa: PLC0415
    text = "# comment\n\nhttps://gelbooru.com/a\n  https://kemono.cr/b  \n# end\n"
    assert parse_creators_file(text) == ["https://gelbooru.com/a", "https://kemono.cr/b"]
```
> 该 import 需要 `scripts/` 在 sys.path。脚本文件把 `SERVER_ROOT/src` 注入 path；测试从 `server/` 运行（`pyproject` 的 pytest rootdir），`scripts` 作为顶层包可直接 import。若 import 失败，在 Step 3 顺带在 `tests/` 加一个 `conftest` path 注入；当前 conftest 已使 `src` 可 import，`scripts` 同理由 pytest rootdir 解析。

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gallery_dl_import.py -k parse_creators_file -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'scripts.fetch_creators'`.

- [ ] **Step 3: Write minimal implementation**

新建 `server/scripts/fetch_creators.py`（骨架照 `clean_non_image_posts.py`）：
```python
"""Fetch images by creator/tag URL list via gallery-dl, persist to the library.

Reads a newline-delimited URL list (default: server/creators.txt), runs each
through services.gallery_dl_import, and reports per-URL results. Dry-run by
default: fetches metadata + dedupes against the DB but downloads/writes nothing.

Run from the server/ dir:
    uv run python scripts/fetch_creators.py                 # dry-run (default)
    uv run python scripts/fetch_creators.py --apply         # download + persist
    uv run python scripts/fetch_creators.py --apply --sync  # then run sync-metadata workers
    uv run python scripts/fetch_creators.py --list my.txt --config gallery-dl.conf
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import sqlite_vec

for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from server.commands import ensure_canonical_tag_groups_sync  # noqa: E402
from services.gallery_dl_import import import_from_url  # noqa: E402

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"
DEFAULT_LIST = SERVER_ROOT / "creators.txt"


def parse_creators_file(text: str) -> list[str]:
    """Return non-comment, non-blank, stripped URLs from a creators list."""
    urls: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            urls.append(stripped)
    return urls


class _DBShim:
    """Minimal db.cursor() provider for gallery_dl_import (script is single-threaded)."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def cursor(self) -> sqlite3.Cursor:
        return self._conn.cursor()


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--config", type=Path, default=None, help="gallery-dl.conf path")
    parser.add_argument("--apply", action="store_true", help="download + persist (default dry-run)")
    parser.add_argument("--sync", action="store_true", help="run sync-metadata workers after import")
    args = parser.parse_args()

    if not args.list.is_file():
        print(f"List file not found: {args.list}")
        return
    urls = parse_creators_file(args.list.read_text(encoding="utf-8"))
    print(f"List:   {args.list} ({len(urls)} urls)")
    print(f"DB:     {args.db}")
    print(f"mode:   {'APPLY' if args.apply else 'DRY-RUN'}\n")

    conn = _connect(args.db)
    db = _DBShim(conn)
    try:
        type_to_group = ensure_canonical_tag_groups_sync(conn.cursor())
        conn.commit()
        config_path = str(args.config) if args.config else None
        for url in urls:
            try:
                s = import_from_url(url, db=db, type_to_group_id=type_to_group,
                                    apply=args.apply, config_path=config_path)
                conn.commit()
                print(f"  OK   {url}\n       fetched={s.fetched} images={s.images} "
                      f"new={s.new} downloaded={s.downloaded} failed={s.failed}")
            except Exception as exc:  # noqa: BLE001
                conn.rollback()
                print(f"  FAIL {url}\n       {exc}")
    finally:
        conn.close()

    if args.apply and args.sync:
        print("\nRun `POST /v2/cmd/sync-metadata` (or restart) to backfill embedding/scores/auto-tags.")
    elif args.apply:
        print("\nDone. Run sync-metadata to backfill embedding/scores/auto-tags.")


if __name__ == "__main__":
    main()
```
> `--sync` 第一版只打印提示（脚本是离线进程，不直接驱动 GPU worker）；真正触发交给运行中的后端端点。若后续要脚本内直跑，再单列任务。

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gallery_dl_import.py -k parse_creators_file -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/scripts/fetch_creators.py server/tests/test_gallery_dl_import.py
git commit -m "feat(gallery-dl): add fetch_creators driver script"
```

---

## Task 11: 清单样例 + gitignore

**Files:**
- Create: `server/creators.txt.example`
- Modify: `server/.gitignore`（无则创建）

- [ ] **Step 1: 写样例**

新建 `server/creators.txt.example`：
```
# 每行一个 gallery-dl 能直接识别的 URL；# 注释、空行被忽略。
# Booru 的“作者” = artist tag 搜索：
https://gelbooru.com/index.php?page=post&s=list&tags=hews
https://yande.re/post?tags=wlop
# Kemono 的 creator 页：
https://kemono.cr/patreon/user/12345
```

- [ ] **Step 2: 忽略私有清单与配置**

在 `server/.gitignore` 追加（无则创建该文件）：
```
creators.txt
gallery-dl.conf
```

- [ ] **Step 3: Commit**

```bash
git add server/creators.txt.example server/.gitignore
git commit -m "chore(gallery-dl): add creators list example and gitignore"
```

---

## Task 12: 全套验证

- [ ] **Step 1: 跑全后端测试**

Run（`server/`）:
```bash
uv run pytest -q
```
Expected: 全绿（含既有 golden-master 套件，证明 danbooru source 改动无回归）。

- [ ] **Step 2: Lint**

Run:
```bash
uv run ruff check src scripts
```
Expected: 无错误。

- [ ] **Step 3: 真实 dry-run 冒烟（需网络）**

Run:
```bash
cp creators.txt.example creators.txt
uv run python scripts/fetch_creators.py --list creators.txt
```
Expected: 对 Booru URL 打印 `fetched/images/new`（new>0），不下载、不写库；Kemono 行若 403 打印 `FAIL ...` 但不中断。

- [ ] **Step 4: 真实 apply 冒烟（需网络，少量）**

挑一个结果很少的 artist tag，`--apply` 跑一次，确认 `target_dir/gelbooru/<tag>/` 下出现图片、**没有任何 `.json`**，DB 里新 posts 带 tag 与 source。

- [ ] **Step 5: 文档收尾 commit（如有微调）**

```bash
git add -A
git commit -m "test(gallery-dl): verify end-to-end dry-run and apply"
```

---

## Self-Review 记录

- **Spec 覆盖**：subprocess `-j`（T4）/ 零落盘 + 自下载（T7,T9）/ 方案 B tag 映射（T5,T6）/ source 原则 + danbooru 修正（T2）/ `(file_path,file_name,extension)` 去重（T9 existing 预检 + INSERT ON CONFLICT）/ 清单文件（T10,T11）/ 只入图片（T5 过滤）/ CF 配置（T4 `--config`、T9 headers 预留）/ `--sync` 提示（T10）/ 测试（贯穿）—— 均有对应任务。
- **类型一致**：`GalleryDLItem` 字段在 T5 定义，T6/T7/T8/T9 一致使用；`run_gallery_dl_json` 返回 `list[tuple[str, dict]]` 在 T4 定义、T9 消费；`GalleryDLStats.new/downloaded/...` 在 T9 定义并被脚本（T10）读取，字段名一致。
- **已知校正点**：gallery-dl `-j` 的 message type 数值（`_MSG_URL=3`）与 Booru tag 字段名（`tags_*`）在 T3 用真实样本核对；moebooru 扁平 `tags` 的情况第一版允许整批落 general 或留待自动 tagger（spec 已声明，非阻塞）。
