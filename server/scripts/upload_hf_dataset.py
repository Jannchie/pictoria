"""Incrementally upload Pictoria images + metadata to a HuggingFace dataset repo.

Layout produced in the dataset repo:

    images/<ab>/<sha256>.<ext>        content-addressed image files
    metadata/shard_<NNNNNN>.parquet   metadata sharded by post_id // shard_size
    manifest.json                     per-post row_hash + sha256 + shard mapping
    README.md                         dataset card (written on first upload only)

A second run compares the local DB against `manifest.json` pulled from the Hub and
only re-uploads:

  * image files whose sha256 isn't already in the repo, and
  * parquet shards that contain at least one new / changed / removed row.

Run:

    uv run scripts/upload_hf_dataset.py --repo user/pictoria-dataset \\
        --target-dir ./illustration/images
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import tempfile
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from dotenv import load_dotenv
from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError, RepositoryNotFoundError
from minio.error import S3Error
from rich.logging import RichHandler

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import shared
from progress import get_progress
from services.s3 import get_s3_client
from utils import prepare_s3

if TYPE_CHECKING:
    from minio import Minio

SourceMode = Literal["local-first", "local-only", "s3-only"]

MANIFEST_PATH = "manifest.json"
README_PATH = "README.md"
METADATA_DIR = "metadata"
IMAGES_DIR = "images"
SCHEMA_VERSION = 1
DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.duckdb"

logger = logging.getLogger("pictoria.hf-upload")


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", required=True, help="HF dataset repo id, e.g. username/pictoria-dataset")
    p.add_argument("--target-dir", type=Path, required=True, help="Pictoria target_dir (root of local image files)")
    p.add_argument("--db-path", type=Path, default=None, help=f"DuckDB path (default: {DEFAULT_DB})")
    p.add_argument("--token", default=os.environ.get("HF_TOKEN"), help="HF token (defaults to $HF_TOKEN or cached login)")
    p.add_argument("--shard-size", type=int, default=1000, help="Posts per metadata shard (default 1000)")
    p.add_argument("--commit-batch", type=int, default=200, help="Max file operations per commit (default 200)")
    p.add_argument("--private", action="store_true", help="Create repo as private (only used on first creation)")
    p.add_argument("--no-images", action="store_true", help="Metadata-only run; do not upload image files")
    p.add_argument("--limit", type=int, default=None, help="Process at most N posts (smoke testing)")
    p.add_argument("--dry-run", action="store_true", help="Print plan without uploading anything")
    p.add_argument(
        "--source",
        choices=("local-first", "local-only", "s3-only"),
        default="local-first",
        help="Where to read image bytes from: local-first (default), local-only, or s3-only",
    )
    p.add_argument("--s3-workers", type=int, default=8, help="Parallel S3 download workers (default 8)")
    return p.parse_args()


# --------------------------------------------------------------------------------------
# Repo path helpers
# --------------------------------------------------------------------------------------


def image_repo_path(sha256: str, extension: str) -> str:
    ext = extension.lstrip(".").lower()
    return f"{IMAGES_DIR}/{sha256[:2]}/{sha256}.{ext}"


def shard_repo_path(shard_id: int) -> str:
    return f"{METADATA_DIR}/shard_{shard_id:06d}.parquet"


def shard_for(post_id: int, shard_size: int) -> int:
    return post_id // shard_size


# --------------------------------------------------------------------------------------
# Parquet schema + record builder
# --------------------------------------------------------------------------------------


PARQUET_SCHEMA = pa.schema(
    [
        ("post_id", pa.int64()),
        ("file_name", pa.string()),
        ("extension", pa.string()),
        ("sha256", pa.string()),
        ("image_path", pa.string()),
        ("width", pa.int32()),
        ("height", pa.int32()),
        ("aspect_ratio", pa.float64()),
        ("published_at", pa.timestamp("us", tz="UTC")),
        ("score", pa.int32()),
        ("rating", pa.int32()),
        ("description", pa.string()),
        ("meta", pa.string()),
        ("source", pa.string()),
        ("caption", pa.string()),
        ("thumbhash", pa.string()),
        ("size", pa.int64()),
        ("dominant_color", pa.list_(pa.float32())),
        (
            "tags",
            pa.list_(
                pa.struct(
                    [
                        ("name", pa.string()),
                        ("group", pa.string()),
                        ("is_auto", pa.bool_()),
                    ],
                ),
            ),
        ),
        ("colors", pa.list_(pa.int32())),
        ("waifu_score", pa.float32()),
        ("created_at", pa.timestamp("us", tz="UTC")),
        ("updated_at", pa.timestamp("us", tz="UTC")),
    ],
)


def _aware_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


# --------------------------------------------------------------------------------------
# Post: flat row pulled from DuckDB
# --------------------------------------------------------------------------------------


@dataclass
class PostRow:
    id: int
    file_path: str
    file_name: str
    extension: str
    full_path: str
    width: int
    height: int
    aspect_ratio: float | None
    published_at: datetime | None
    score: int
    rating: int
    description: str
    meta: str
    sha256: str
    size: int
    source: str
    caption: str
    thumbhash: str | None
    dominant_color: list[float] | None
    created_at: datetime
    updated_at: datetime
    tags: list[dict[str, Any]]  # [{name, group, is_auto}, ...]
    colors: list[int]
    waifu_score: float | None


def post_to_record(post: PostRow) -> dict[str, Any]:
    """Project a PostRow into a parquet-ready dict."""
    dominant: list[float] | None = None
    if post.dominant_color is not None:
        try:
            dominant = [float(x) for x in post.dominant_color]
        except TypeError:
            dominant = None

    tags = [
        {
            "name": t["name"],
            "group": t.get("group"),
            "is_auto": bool(t.get("is_auto")),
        }
        for t in post.tags
        if t.get("name")
    ]
    tags.sort(key=lambda t: (t["group"] or "~", t["name"]))

    return {
        "post_id": int(post.id),
        "file_name": post.file_name,
        "extension": post.extension,
        "sha256": post.sha256 or "",
        "image_path": image_repo_path(post.sha256, post.extension) if post.sha256 else None,
        "width": int(post.width),
        "height": int(post.height),
        "aspect_ratio": float(post.aspect_ratio) if post.aspect_ratio is not None else None,
        "published_at": _aware_utc(post.published_at),
        "score": int(post.score),
        "rating": int(post.rating),
        "description": post.description,
        "meta": post.meta,
        "source": post.source,
        "caption": post.caption,
        "thumbhash": post.thumbhash,
        "size": int(post.size),
        "dominant_color": dominant,
        "tags": tags,
        "colors": [int(c) for c in post.colors],
        "waifu_score": float(post.waifu_score) if post.waifu_score is not None else None,
        "created_at": _aware_utc(post.created_at),
        "updated_at": _aware_utc(post.updated_at),
    }


def row_hash(record: dict[str, Any]) -> str:
    """Stable hash of a metadata row, excluding volatile timestamps."""
    payload = {k: v for k, v in record.items() if k not in {"created_at", "updated_at"}}
    blob = json.dumps(payload, default=_json_default, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    msg = f"Cannot serialize {type(value).__name__}"
    raise TypeError(msg)


# --------------------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------------------


@dataclass
class Manifest:
    version: int = SCHEMA_VERSION
    shard_size: int = 1000
    updated_at: str | None = None
    posts: dict[str, dict[str, Any]] = field(default_factory=dict)
    images: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "shard_size": self.shard_size,
            "updated_at": self.updated_at,
            "posts": self.posts,
            "images": self.images,
        }


def load_remote_manifest(repo_id: str, token: str | None, shard_size: int) -> Manifest:
    try:
        path = hf_hub_download(repo_id=repo_id, filename=MANIFEST_PATH, repo_type="dataset", token=token)
    except (EntryNotFoundError, RepositoryNotFoundError):
        logger.info("No remote manifest yet; starting from empty state")
        return Manifest(shard_size=shard_size)
    except Exception as exc:
        logger.warning("Failed to load remote manifest (%s); starting from empty state", exc)
        return Manifest(shard_size=shard_size)
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return Manifest(
        version=int(data.get("version", SCHEMA_VERSION)),
        shard_size=int(data.get("shard_size", shard_size)),
        updated_at=data.get("updated_at"),
        posts=dict(data.get("posts", {})),
        images=dict(data.get("images", {})),
    )


# --------------------------------------------------------------------------------------
# Diff planning
# --------------------------------------------------------------------------------------


@dataclass
class PendingImage:
    sha256: str
    extension: str
    full_path: str
    post_id: int
    repo_path: str


@dataclass
class Plan:
    new_manifest: Manifest
    dirty_shards: dict[int, list[dict[str, Any]]]
    image_uploads: dict[str, PendingImage]
    image_deletes: list[str]
    shard_deletes: list[int]

    def is_empty(self) -> bool:
        return not (self.dirty_shards or self.image_uploads or self.image_deletes or self.shard_deletes)


def _mark_dirty(prev: dict[str, Any] | None, rhash: str, shard_id: int, dirty: set[int]) -> None:
    if prev is None or prev.get("h") != rhash or prev.get("shard") != shard_id:
        dirty.add(shard_id)
        if prev is not None and prev.get("shard") != shard_id:
            dirty.add(int(prev["shard"]))


def _maybe_queue_image_upload(post: PostRow, record: dict[str, Any], previous: Manifest, queue: dict[str, PendingImage]) -> None:
    sha = record["sha256"]
    if not sha or sha in previous.images or sha in queue:
        return
    queue[sha] = PendingImage(
        sha256=sha,
        extension=record["extension"],
        full_path=post.full_path,
        post_id=post.id,
        repo_path=image_repo_path(sha, record["extension"]),
    )


def build_plan(posts: Iterable[PostRow], previous: Manifest, *, shard_size: int) -> Plan:
    new_manifest = Manifest(shard_size=shard_size, updated_at=datetime.now(tz=UTC).isoformat())
    dirty_shard_ids: set[int] = set()
    seen_post_ids: set[str] = set()
    records_by_shard: dict[int, list[dict[str, Any]]] = {}
    image_uploads: dict[str, PendingImage] = {}

    for post in posts:
        record = post_to_record(post)
        pid = str(post.id)
        seen_post_ids.add(pid)
        shard_id = shard_for(post.id, shard_size)
        records_by_shard.setdefault(shard_id, []).append(record)

        rhash = row_hash(record)
        new_manifest.posts[pid] = {"h": rhash, "s": record["sha256"], "e": record["extension"], "shard": shard_id}

        sha = record["sha256"]
        if sha:
            img = new_manifest.images.setdefault(sha, {"e": record["extension"], "refs": []})
            img["refs"].append(post.id)

        _mark_dirty(previous.posts.get(pid), rhash, shard_id, dirty_shard_ids)
        _maybe_queue_image_upload(post, record, previous, image_uploads)

    # Removed posts: in previous but not seen — their old shards dirty
    for pid, prev in previous.posts.items():
        if pid in seen_post_ids:
            continue
        dirty_shard_ids.add(int(prev["shard"]))

    # Decide image deletes: sha256s with refs in previous but no refs in new manifest
    image_deletes: list[str] = [
        image_repo_path(sha, prev_img.get("e", ""))
        for sha, prev_img in previous.images.items()
        if sha not in new_manifest.images
    ]

    prev_shards = {int(m["shard"]) for m in previous.posts.values()}
    new_shards = {int(m["shard"]) for m in new_manifest.posts.values()}
    shard_deletes = sorted(prev_shards - new_shards)

    dirty_shards = {sid: records_by_shard.get(sid, []) for sid in sorted(dirty_shard_ids) if sid in new_shards}

    return Plan(
        new_manifest=new_manifest,
        dirty_shards=dirty_shards,
        image_uploads=image_uploads,
        image_deletes=image_deletes,
        shard_deletes=shard_deletes,
    )


# --------------------------------------------------------------------------------------
# Parquet writing
# --------------------------------------------------------------------------------------


def write_shard_parquet(records: list[dict[str, Any]], dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    records.sort(key=lambda r: r["post_id"])
    table = pa.Table.from_pylist(records, schema=PARQUET_SCHEMA)
    pq.write_table(table, dest, compression="zstd")


# --------------------------------------------------------------------------------------
# Upload orchestration
# --------------------------------------------------------------------------------------


DATASET_README = """\
---
license: other
task_categories: []
pretty_name: Pictoria Dataset
size_categories: []
---

# Pictoria Dataset

Auto-generated export from [Pictoria](https://github.com/Jianqi-Pan/pictoria).

## Layout

* `metadata/shard_*.parquet` — sharded metadata (one row per image).
* `images/<ab>/<sha256>.<ext>` — content-addressed image files.
* `manifest.json` — incremental-upload state. Safe to ignore for consumers.

## Quick start

```python
from datasets import load_dataset, Image

ds = load_dataset("{repo_id}", data_files="metadata/*.parquet", split="train")
ds = ds.cast_column("image_path", Image())
```
"""


def chunked(items: list[Any], size: int) -> Iterator[list[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


# --------------------------------------------------------------------------------------
# Image source: local FS + S3 fallback
# --------------------------------------------------------------------------------------


@dataclass
class ImageSourceConfig:
    mode: SourceMode
    target_dir: Path
    tmp_dir: Path
    s3_workers: int = 8


def _fetch_local(target_dir: Path, full_path: str) -> Path | None:
    p = target_dir / full_path
    return p if p.is_file() else None


def _fetch_s3(client: Minio, full_path: str, sha256: str, extension: str, tmp_dir: Path) -> Path | None:
    if not (shared.s3_endpoint and shared.s3_bucket):
        return None
    key = f"{shared.s3_base_dir}/{full_path}"
    dest = tmp_dir / f"{sha256}.{extension.lstrip('.').lower()}"
    try:
        client.fget_object(shared.s3_bucket, key, str(dest))
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject"}:
            return None
        raise
    return dest if dest.exists() else None


def _resolve_pending(pending: PendingImage, cfg: ImageSourceConfig, s3: Minio | None) -> Path | None:
    if cfg.mode in {"local-first", "local-only"}:
        local = _fetch_local(cfg.target_dir, pending.full_path)
        if local is not None:
            return local
        if cfg.mode == "local-only":
            return None
    if s3 is None:
        return None
    return _fetch_s3(s3, pending.full_path, pending.sha256, pending.extension, cfg.tmp_dir)


@dataclass
class RepoTarget:
    api: HfApi
    repo_id: str
    token: str | None


def ensure_repo(target: RepoTarget, *, private: bool) -> bool:
    """Create the repo if it doesn't exist. Returns True if it was newly created."""
    try:
        target.api.repo_info(repo_id=target.repo_id, repo_type="dataset", token=target.token)
    except RepositoryNotFoundError:
        logger.info("Creating dataset repo [bold]%s[/bold]", target.repo_id)
        target.api.create_repo(repo_id=target.repo_id, repo_type="dataset", token=target.token, private=private, exist_ok=True)
        return True
    return False


def existing_image_paths(target: RepoTarget) -> set[str]:
    try:
        files = target.api.list_repo_files(repo_id=target.repo_id, repo_type="dataset", token=target.token)
    except RepositoryNotFoundError:
        return set()
    return {f for f in files if f.startswith(f"{IMAGES_DIR}/")}


def _resolve_all(pending: list[PendingImage], cfg: ImageSourceConfig, s3: Minio | None) -> tuple[list[tuple[PendingImage, Path]], list[PendingImage]]:
    resolved: list[tuple[PendingImage, Path]] = []
    missing: list[PendingImage] = []
    progress = get_progress()
    with progress, ThreadPoolExecutor(max_workers=cfg.s3_workers) as ex:
        task = progress.add_task(f"Resolving images ({cfg.mode})", total=len(pending))
        futures = {ex.submit(_resolve_pending, p, cfg, s3): p for p in pending}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                path = fut.result()
            except Exception as exc:
                logger.warning("Failed to fetch sha=%s (%s): %s", p.sha256, p.full_path, exc)
                missing.append(p)
            else:
                if path is None:
                    missing.append(p)
                else:
                    resolved.append((p, path))
            progress.advance(task)
    return resolved, missing


def _upload_new_images(
    target: RepoTarget,
    plan: Plan,
    *,
    commit_batch: int,
    cfg: ImageSourceConfig,
    s3: Minio | None,
) -> list[PendingImage]:
    if not plan.image_uploads:
        return []
    present = existing_image_paths(target)
    needed = [p for p in plan.image_uploads.values() if p.repo_path not in present]
    if (skipped := len(plan.image_uploads) - len(needed)) > 0:
        logger.info("Skipping %d images already present in repo", skipped)
    if not needed:
        return []
    resolved, missing = _resolve_all(needed, cfg, s3)
    logger.info("Resolved %d / %d images (%d missing)", len(resolved), len(needed), len(missing))

    for batch_idx, batch in enumerate(chunked(resolved, commit_batch), start=1):
        ops = [CommitOperationAdd(path_in_repo=p.repo_path, path_or_fileobj=str(path)) for p, path in batch]
        logger.info("Uploading image batch %d (%d files)", batch_idx, len(batch))
        target.api.create_commit(
            repo_id=target.repo_id,
            repo_type="dataset",
            operations=ops,
            commit_message=f"upload images batch {batch_idx} ({len(batch)} files)",
            token=target.token,
        )
        for _p, path in batch:
            try:
                if path.is_relative_to(cfg.tmp_dir):
                    path.unlink(missing_ok=True)
            except OSError:
                pass

    return missing


def _build_final_ops(
    tmp: Path,
    plan: Plan,
    repo_id: str,
    *,
    write_readme: bool,
) -> list[CommitOperationAdd | CommitOperationDelete]:
    ops: list[CommitOperationAdd | CommitOperationDelete] = []

    for shard_id, records in plan.dirty_shards.items():
        local = tmp / f"shard_{shard_id:06d}.parquet"
        write_shard_parquet(records, local)
        ops.append(CommitOperationAdd(path_in_repo=shard_repo_path(shard_id), path_or_fileobj=str(local)))

    ops.extend(CommitOperationDelete(path_in_repo=shard_repo_path(sid)) for sid in plan.shard_deletes)
    ops.extend(CommitOperationDelete(path_in_repo=p) for p in plan.image_deletes)

    manifest_local = tmp / "manifest.json"
    manifest_local.write_text(
        json.dumps(plan.new_manifest.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    ops.append(CommitOperationAdd(path_in_repo=MANIFEST_PATH, path_or_fileobj=str(manifest_local)))

    if write_readme:
        readme_local = tmp / "README.md"
        readme_local.write_text(DATASET_README.format(repo_id=repo_id), encoding="utf-8")
        ops.append(CommitOperationAdd(path_in_repo=README_PATH, path_or_fileobj=str(readme_local)))

    return ops


@dataclass
class ExecuteOptions:
    commit_batch: int
    upload_images: bool
    write_readme: bool
    source_mode: SourceMode
    target_dir: Path
    s3_workers: int


def execute_plan(target: RepoTarget, plan: Plan, opts: ExecuteOptions) -> list[PendingImage]:
    """Run the upload plan. Returns images that couldn't be located."""
    missing: list[PendingImage] = []
    with tempfile.TemporaryDirectory(prefix="pictoria-hf-") as tmp_str:
        tmp = Path(tmp_str)
        s3_cache = tmp / "s3_cache"
        s3_cache.mkdir()

        cfg = ImageSourceConfig(mode=opts.source_mode, target_dir=opts.target_dir, tmp_dir=s3_cache, s3_workers=opts.s3_workers)
        s3 = get_s3_client() if opts.source_mode != "local-only" and shared.s3_endpoint else None

        if opts.upload_images:
            missing = _upload_new_images(target, plan, commit_batch=opts.commit_batch, cfg=cfg, s3=s3)

        ops = _build_final_ops(tmp, plan, target.repo_id, write_readme=opts.write_readme)
        logger.info(
            "Final commit: %d shard writes, %d shard deletes, %d image deletes, +manifest",
            len(plan.dirty_shards),
            len(plan.shard_deletes),
            len(plan.image_deletes),
        )
        target.api.create_commit(
            repo_id=target.repo_id,
            repo_type="dataset",
            operations=ops,
            commit_message=f"sync metadata ({len(plan.dirty_shards)} shards, {len(plan.new_manifest.posts)} posts)",
            token=target.token,
        )
    return missing


# --------------------------------------------------------------------------------------
# DuckDB streaming reader
# --------------------------------------------------------------------------------------


_POST_SQL = """
    SELECT
        p.id, p.file_path, p.file_name, p.extension, p.full_path,
        p.width, p.height, p.aspect_ratio, p.published_at,
        p.score, p.rating, p.description, p.meta, p.sha256, p.size,
        p.source, p.caption, p.thumbhash, p.dominant_color,
        p.created_at, p.updated_at,
        COALESCE((
            SELECT list({name: t.name, group: tg.name, is_auto: pht.is_auto})
            FROM post_has_tag pht
            JOIN tags t ON t.name = pht.tag_name
            LEFT JOIN tag_groups tg ON tg.id = t.group_id
            WHERE pht.post_id = p.id
        ), []) AS tags,
        COALESCE((
            SELECT list(color ORDER BY "order")
            FROM post_has_color
            WHERE post_id = p.id
        ), []) AS colors,
        (SELECT score FROM post_waifu_scores WHERE post_id = p.id) AS waifu_score
    FROM posts p
    ORDER BY p.id
"""


def _row_to_postrow(r: tuple) -> PostRow:
    return PostRow(
        id=r[0], file_path=r[1], file_name=r[2], extension=r[3], full_path=r[4],
        width=r[5] or 0, height=r[6] or 0, aspect_ratio=r[7],
        published_at=r[8], score=r[9] or 0, rating=r[10] or 0,
        description=r[11] or "", meta=r[12] or "", sha256=r[13] or "",
        size=r[14] or 0, source=r[15] or "", caption=r[16] or "",
        thumbhash=r[17], dominant_color=list(r[18]) if r[18] is not None else None,
        created_at=r[19], updated_at=r[20],
        tags=list(r[21] or []), colors=list(r[22] or []),
        waifu_score=r[23],
    )


def fetch_all_posts(conn: duckdb.DuckDBPyConnection, limit: int | None) -> tuple[int, Iterator[PostRow]]:
    raw_total = int(conn.execute("SELECT count(*) FROM posts").fetchone()[0])
    total = min(raw_total, limit) if limit is not None else raw_total

    sql = _POST_SQL + (f" LIMIT {int(limit)}" if limit is not None else "")
    conn.execute(sql)

    def stream() -> Iterator[PostRow]:
        while chunk := conn.fetchmany(500):
            for r in chunk:
                yield _row_to_postrow(r)

    return total, stream()


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def _validate_s3_config(args: argparse.Namespace) -> None:
    needs_s3 = args.source != "local-only" and not args.no_images
    if not needs_s3:
        return
    if shared.s3_endpoint and shared.s3_access_key and shared.s3_secret_key:
        return
    if args.source == "s3-only":
        msg = "--source s3-only requires S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY in env"
        raise SystemExit(msg)
    logger.warning("S3 env vars not set; falling back to local-only image source")
    args.source = "local-only"


def _collect_plan(args: argparse.Namespace, previous: Manifest, conn: duckdb.DuckDBPyConnection) -> Plan:
    total, posts_iter = fetch_all_posts(conn, args.limit)
    logger.info("Scanning %d posts...", total)
    progress = get_progress()
    with progress:
        task = progress.add_task("Building plan", total=total)
        collected: list[PostRow] = []
        for post in posts_iter:
            collected.append(post)
            progress.update(task, advance=1)
    return build_plan(collected, previous, shard_size=args.shard_size)


def _report_missing(missing: list[PendingImage]) -> None:
    if not missing:
        return
    sample = 10
    logger.warning("%d images could not be located (neither local nor S3); metadata rows were still written", len(missing))
    for p in missing[:sample]:
        logger.warning("  missing sha=%s post_id=%d full_path=%s", p.sha256, p.post_id, p.full_path)
    if len(missing) > sample:
        logger.warning("  ... and %d more", len(missing) - sample)


def main() -> None:
    load_dotenv()
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", handlers=[RichHandler(markup=True)], force=True)

    target_dir: Path = args.target_dir.resolve()
    if not target_dir.exists():
        msg = f"--target-dir does not exist: {target_dir}"
        raise SystemExit(msg)
    shared.target_dir = target_dir
    prepare_s3()
    _validate_s3_config(args)

    db_path = args.db_path or DEFAULT_DB
    if not db_path.exists():
        msg = f"DuckDB not found at {db_path}"
        raise SystemExit(msg)
    conn = duckdb.connect(str(db_path), read_only=True)

    try:
        target = RepoTarget(api=HfApi(), repo_id=args.repo, token=args.token)
        created = False if args.dry_run else ensure_repo(target, private=args.private)

        previous = Manifest(shard_size=args.shard_size) if args.dry_run else load_remote_manifest(args.repo, args.token, args.shard_size)
        if previous.shard_size != args.shard_size and previous.posts:
            logger.warning("Remote manifest shard_size=%d differs from --shard-size=%d; keeping remote value", previous.shard_size, args.shard_size)
            args.shard_size = previous.shard_size

        plan = _collect_plan(args, previous, conn)
        logger.info(
            "Plan: %d new/changed shards, %d shard deletes, %d new images, %d image deletes",
            len(plan.dirty_shards),
            len(plan.shard_deletes),
            len(plan.image_uploads),
            len(plan.image_deletes),
        )

        if plan.is_empty() and not created:
            logger.info("Nothing to upload — repo is already in sync.")
            return
        if args.dry_run:
            logger.info("Dry run; not uploading.")
            return

        missing = execute_plan(
            target,
            plan,
            ExecuteOptions(
                commit_batch=args.commit_batch,
                upload_images=not args.no_images,
                write_readme=created,
                source_mode=args.source,
                target_dir=target_dir,
                s3_workers=args.s3_workers,
            ),
        )
        _report_missing(missing)
        logger.info("Done. Visit https://huggingface.co/datasets/%s", args.repo)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
