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
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pyarrow as pa
import pyarrow.parquet as pq
from dotenv import load_dotenv
from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError, RepositoryNotFoundError
from rich.logging import RichHandler
from sqlalchemy import func, select

import shared
from models import Post
from progress import get_progress
from utils import get_session

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator

MANIFEST_PATH = "manifest.json"
README_PATH = "README.md"
METADATA_DIR = "metadata"
IMAGES_DIR = "images"
SCHEMA_VERSION = 1

logger = logging.getLogger("pictoria.hf-upload")


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", required=True, help="HF dataset repo id, e.g. username/pictoria-dataset")
    p.add_argument("--target-dir", type=Path, required=True, help="Pictoria target_dir (root of local image files)")
    p.add_argument("--token", default=os.environ.get("HF_TOKEN"), help="HF token (defaults to $HF_TOKEN or cached login)")
    p.add_argument("--shard-size", type=int, default=1000, help="Posts per metadata shard (default 1000)")
    p.add_argument("--commit-batch", type=int, default=200, help="Max file operations per commit (default 200)")
    p.add_argument("--private", action="store_true", help="Create repo as private (only used on first creation)")
    p.add_argument("--no-images", action="store_true", help="Metadata-only run; do not upload image files")
    p.add_argument("--limit", type=int, default=None, help="Process at most N posts (smoke testing)")
    p.add_argument("--dry-run", action="store_true", help="Print plan without uploading anything")
    p.add_argument(
        "--fallback-prefix",
        action="append",
        default=None,
        help="Extra subdir under --target-dir to search if a post's file_path doesn't resolve (repeatable, default: 'danbooru')",
    )
    return p.parse_args()


def resolve_local_image(target_dir: Path, full_path: str, fallback_prefixes: list[str]) -> Path | None:
    """Locate a post's image on disk, trying target_dir first, then with each fallback prefix."""
    primary = target_dir / full_path
    if primary.exists():
        return primary
    for prefix in fallback_prefixes:
        candidate = target_dir / prefix / full_path
        if candidate.exists():
            return candidate
    return None


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


def post_to_record(post: Post) -> dict[str, Any]:
    """Project a Post (with selectin'd relationships) into a parquet-ready dict."""
    dominant: list[float] | None = None
    if post.dominant_color is not None:
        try:
            dominant = [float(x) for x in post.dominant_color]
        except TypeError:
            dominant = None

    tags = [
        {
            "name": t.tag_name,
            "group": (t.tag_info.group.name if (t.tag_info and t.tag_info.group) else None),
            "is_auto": bool(t.is_auto),
        }
        for t in post.tags
    ]
    tags.sort(key=lambda t: (t["group"] or "~", t["name"]))

    colors = [int(c.color) for c in sorted(post.colors, key=lambda c: c.order)]

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
        "colors": colors,
        "waifu_score": float(post.waifu_score.score) if post.waifu_score else None,
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
    # post_id (string) -> {h: row_hash, s: sha256, e: extension, shard: int}
    posts: dict[str, dict[str, Any]] = field(default_factory=dict)
    # sha256 -> {e: extension, refs: [post_id, ...]}
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
class Plan:
    new_manifest: Manifest
    dirty_shards: dict[int, list[dict[str, Any]]]
    image_uploads: dict[str, tuple[Path, str]]  # sha256 -> (local_path, repo_path)
    image_deletes: list[str]  # repo paths
    shard_deletes: list[int]  # shard ids
    missing_local: list[tuple[int, str]] = field(default_factory=list)  # (post_id, full_path)

    def is_empty(self) -> bool:
        return not (self.dirty_shards or self.image_uploads or self.image_deletes or self.shard_deletes)


def _mark_dirty(prev: dict[str, Any] | None, rhash: str, shard_id: int, dirty: set[int]) -> None:
    if prev is None or prev.get("h") != rhash or prev.get("shard") != shard_id:
        dirty.add(shard_id)
        if prev is not None and prev.get("shard") != shard_id:
            dirty.add(int(prev["shard"]))


@dataclass
class ResolveCtx:
    target_dir: Path
    fallback_prefixes: list[str]
    previous: Manifest
    image_uploads: dict[str, tuple[Path, str]]
    missing_local: list[tuple[int, str]]


def _maybe_queue_image_upload(post: Post, record: dict[str, Any], ctx: ResolveCtx) -> None:
    sha = record["sha256"]
    if not sha or sha in ctx.previous.images or sha in ctx.image_uploads:
        return
    local = resolve_local_image(ctx.target_dir, post.full_path, ctx.fallback_prefixes)
    if local is None:
        ctx.missing_local.append((post.id, post.full_path))
        return
    ctx.image_uploads[sha] = (local, image_repo_path(sha, record["extension"]))


def build_plan(
    posts: Iterable[Post],
    previous: Manifest,
    *,
    shard_size: int,
    target_dir: Path,
    fallback_prefixes: list[str],
) -> Plan:
    new_manifest = Manifest(shard_size=shard_size, updated_at=datetime.now(tz=UTC).isoformat())
    dirty_shard_ids: set[int] = set()
    seen_post_ids: set[str] = set()
    records_by_shard: dict[int, list[dict[str, Any]]] = {}
    image_uploads: dict[str, tuple[Path, str]] = {}
    missing_local: list[tuple[int, str]] = []
    ctx = ResolveCtx(
        target_dir=target_dir,
        fallback_prefixes=fallback_prefixes,
        previous=previous,
        image_uploads=image_uploads,
        missing_local=missing_local,
    )

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
        _maybe_queue_image_upload(post, record, ctx)

    # Removed posts: in previous but not seen — their old shards dirty + image refs decrement
    for pid, prev in previous.posts.items():
        if pid in seen_post_ids:
            continue
        dirty_shard_ids.add(int(prev["shard"]))

    # Decide image deletes: sha256s with refs in previous but no refs in new manifest
    image_deletes: list[str] = []
    for sha, prev_img in previous.images.items():
        if sha not in new_manifest.images:
            image_deletes.append(image_repo_path(sha, prev_img.get("e", "")))

    # Shard deletes: shards that previously existed but have zero rows now
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
        missing_local=missing_local,
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


def _upload_new_images(target: RepoTarget, plan: Plan, commit_batch: int) -> None:
    if not plan.image_uploads:
        return
    present = existing_image_paths(target)
    ops: list[CommitOperationAdd] = []
    skipped = 0
    for local, repo_path in plan.image_uploads.values():
        if repo_path in present:
            skipped += 1
            continue
        ops.append(CommitOperationAdd(path_in_repo=repo_path, path_or_fileobj=str(local)))
    if skipped:
        logger.info("Skipping %d images already present in repo", skipped)
    for batch_idx, batch in enumerate(chunked(ops, commit_batch), start=1):
        logger.info("Uploading image batch %d (%d files)", batch_idx, len(batch))
        target.api.create_commit(
            repo_id=target.repo_id,
            repo_type="dataset",
            operations=batch,
            commit_message=f"upload images batch {batch_idx} ({len(batch)} files)",
            token=target.token,
        )


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


def execute_plan(
    target: RepoTarget,
    plan: Plan,
    *,
    commit_batch: int,
    upload_images: bool,
    write_readme: bool,
) -> None:
    if upload_images:
        _upload_new_images(target, plan, commit_batch)

    with tempfile.TemporaryDirectory(prefix="pictoria-hf-") as tmp_str:
        ops = _build_final_ops(Path(tmp_str), plan, target.repo_id, write_readme=write_readme)
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


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def fetch_all_posts(session: Any, limit: int | None) -> tuple[int, Iterator[Post]]:
    total_q = select(func.count(Post.id))
    raw_total = int(session.scalar(total_q) or 0)
    total = min(raw_total, limit) if limit is not None else raw_total

    stmt = select(Post).order_by(Post.id).execution_options(yield_per=500)
    if limit is not None:
        stmt = stmt.limit(limit)
    return total, session.scalars(stmt)


def main() -> None:
    load_dotenv()
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s", handlers=[RichHandler(markup=True)], force=True)

    target_dir: Path = args.target_dir.resolve()
    if not target_dir.exists():
        msg = f"--target-dir does not exist: {target_dir}"
        raise SystemExit(msg)
    shared.target_dir = target_dir

    target = RepoTarget(api=HfApi(), repo_id=args.repo, token=args.token)
    created = False
    if not args.dry_run:
        created = ensure_repo(target, private=args.private)

    previous = Manifest(shard_size=args.shard_size) if args.dry_run else load_remote_manifest(args.repo, args.token, args.shard_size)
    if previous.shard_size != args.shard_size and previous.posts:
        logger.warning(
            "Remote manifest shard_size=%d differs from --shard-size=%d; keeping remote value",
            previous.shard_size,
            args.shard_size,
        )
        args.shard_size = previous.shard_size

    with get_session() as session:
        total, posts_iter = fetch_all_posts(session, args.limit)
        logger.info("Scanning %d posts...", total)

        progress = get_progress()
        with progress:
            task = progress.add_task("Building plan", total=total)
            collected: list[Post] = []
            for post in posts_iter:
                collected.append(post)
                progress.update(task, advance=1)

        fallback_prefixes = args.fallback_prefix if args.fallback_prefix is not None else ["danbooru"]
        plan = build_plan(
            collected,
            previous,
            shard_size=args.shard_size,
            target_dir=target_dir,
            fallback_prefixes=fallback_prefixes,
        )

    logger.info(
        "Plan: %d new/changed shards, %d shard deletes, %d new images, %d image deletes, %d missing local",
        len(plan.dirty_shards),
        len(plan.shard_deletes),
        len(plan.image_uploads),
        len(plan.image_deletes),
        len(plan.missing_local),
    )
    if plan.missing_local:
        sample = 10
        for pid, fp in plan.missing_local[:sample]:
            logger.warning("  missing post_id=%d file_path=%s", pid, fp)
        if len(plan.missing_local) > sample:
            logger.warning("  ... and %d more (not uploaded; rows still written to metadata)", len(plan.missing_local) - sample)

    if plan.is_empty() and not created:
        logger.info("Nothing to upload — repo is already in sync.")
        return

    if args.dry_run:
        logger.info("Dry run; not uploading.")
        return

    execute_plan(
        target,
        plan,
        commit_batch=args.commit_batch,
        upload_images=not args.no_images,
        write_readme=created,
    )
    logger.info("Done. Visit https://huggingface.co/datasets/%s", args.repo)


if __name__ == "__main__":
    main()
