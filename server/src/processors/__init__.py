"""Post-processing pipeline: sha256, thumbhash, embedding, colors, auto-tags.

Refactored from SQLAlchemy session to Native DuckDB Repository pattern.

Performance notes
-----------------
``process_posts`` runs in batches:

1. **Phase 1 — parallel compute** (CPU/IO bound). For each post in the batch,
   open the file, decode the image, compute SHA256 / thumbhash / dominant
   color / palette in a worker thread. Done in parallel via
   ``asyncio.gather``.

2. **Phase 2 — batched DB write** (single transaction). Rather than the four
   separate ``UPDATE posts SET <one column>`` statements per post that the
   row-by-row pipeline used, the basics now go in via one ``UPDATE … SET
   width=?, height=?, sha256=COALESCE(?, sha256), …`` template plus
   ``executemany`` over the whole batch. ``COALESCE`` keeps the existing
   value when a column is unchanged, so the same SQL fits every row regardless
   of which fields it actually computed. ``dominant_color`` stays in its own
   ``WHERE … IS NULL``-guarded UPDATE because the HNSW index on that column
   doesn't tolerate updates of already-set rows.

3. **Phase 3 — per-image GPU work** (CLIP embedding + WDTagger). Still
   serial — these run on a single GPU and need their own batching strategy
   if we want to speed them up further.

A batch is the unit of failure: if anything raises mid-batch the whole
batch is logged as failed and we move on, rather than scattering
half-applied state across the rest of the run.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image
from rich.progress import Progress
from skimage import color

import shared
from services.file_management import add_new_files, remove_deleted_files
from shared import logger
from tools.colors import get_dominant_color, get_palette_ints
from utils import (
    attach_wdtagger_results,
    calculate_sha256,
    calculate_thumbhash,
    create_thumbnail,
    find_files_in_directory,
    from_rating_to_int,
    get_path_name_and_extension,
    get_tagger,
)

if TYPE_CHECKING:
    from io import BufferedReader
    from pathlib import Path

    from db.entities import Post
    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo
    from db.repositories.vectors import VectorRepo


IMAGE_EXTS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"},
)
PROCESS_BATCH_SIZE = 32


async def sync_metadata(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
) -> None:
    """Reconcile disk files vs DB rows, then backfill metadata for unprocessed posts.

    This coroutine runs the full sync inline. Callers who want fire-and-forget
    behavior (e.g. the app's startup lifespan) should wrap the call in
    ``asyncio.create_task`` themselves so they control task lifetime and
    cursor cleanup.
    """
    os_tuples = find_files_in_directory(shared.target_dir)

    def _existing() -> set[tuple[str, str, str]]:
        posts.cur.execute("SELECT file_path, file_name, extension FROM posts")
        return {tuple(r) for r in posts.cur.fetchall()}

    db_tuples_set = await asyncio.to_thread(_existing)
    os_tuples_set = set(os_tuples)
    logger.info(f"DB has {len(db_tuples_set)} files, disk has {len(os_tuples_set)}")

    await remove_deleted_files(posts, os_tuples_set=os_tuples_set, db_tuples_set=db_tuples_set)
    await add_new_files(posts, os_tuples_set=os_tuples_set, db_tuples_set=db_tuples_set)
    await process_posts(posts, vectors, tag_groups)


async def process_posts(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    *,
    all_posts: bool = False,
) -> None:
    """Process posts that haven't been hashed/thumbhashed yet (or all)."""

    def _list_pending() -> list[dict]:
        if all_posts:
            posts.cur.execute("SELECT id, file_path, file_name, extension FROM posts")
        else:
            posts.cur.execute(
                "SELECT id, file_path, file_name, extension FROM posts "
                "WHERE sha256 = '' OR thumbhash IS NULL OR thumbhash = ''",
            )
        return [
            {"id": r[0], "file_path": r[1], "file_name": r[2], "extension": r[3]}
            for r in posts.cur.fetchall()
        ]

    pending = await asyncio.to_thread(_list_pending)
    if not pending:
        logger.info("No posts to process")
        return

    with Progress(console=shared.console) as progress:
        task = progress.add_task("Processing posts...", total=len(pending))
        for i in range(0, len(pending), PROCESS_BATCH_SIZE):
            batch = pending[i:i + PROCESS_BATCH_SIZE]
            try:
                await _process_batch(posts, vectors, tag_groups, batch)
            except Exception:
                logger.exception(
                    f"Batch starting at post {batch[0]['id']} failed; "
                    f"skipping {len(batch)} posts",
                )
            progress.update(task, advance=len(batch))


async def _process_batch(  # noqa: C901
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    batch: list[dict],
) -> None:
    """Run one batch through the three phases (compute / persist / GPU)."""
    # Phase 0: resolve abs paths, drop non-images and stale rows.
    items: list[tuple[Post, Path]] = []
    for p in batch:
        abs_path = (
            shared.target_dir / p["file_path"] / f"{p['file_name']}.{p['extension']}"
        )
        if abs_path.suffix.lower() not in IMAGE_EXTS:
            continue
        post = await posts.get_by_path(p["file_path"], p["file_name"], p["extension"])
        if post is None:
            continue
        if post.sha256 and post.thumbhash:
            continue  # already done since pending list snapshot
        items.append((post, abs_path))
    if not items:
        return

    # Phase 1: compute basics in parallel (CPU/IO in threads).
    raw_results = await asyncio.gather(
        *[
            asyncio.to_thread(_compute_basics_for, post, path)
            for post, path in items
        ],
        return_exceptions=True,
    )
    valid: list[tuple[Post, Path, dict]] = []
    for (post, path), b in zip(items, raw_results, strict=True):
        if isinstance(b, BaseException):
            logger.warning(f"Compute basics failed for {path}: {b}")
            continue
        if b is None:
            continue
        valid.append((post, path, b))
    if not valid:
        return

    # Phase 2: batched DB write.
    await asyncio.to_thread(_persist_basics_batch, posts, valid)

    # Phase 3: per-image GPU pipeline (CLIP + WDTagger) for posts whose
    # sha256 we just computed (i.e. brand-new or never-fully-processed).
    needs_gpu = [(post, path) for post, path, b in valid if b["sha256"] is not None]
    for post, path in needs_gpu:
        try:
            await _run_gpu_pipeline(posts, vectors, tag_groups, post, path)
        except Exception:
            logger.exception(f"GPU pipeline failed for post {post.id} ({path})")


async def process_post(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    file_abs_path: Path | None = None,
) -> None:
    """Process a single post — kept as a public single-shot API.

    Used by ``server.posts.upload_file`` and similar one-off paths. The bulk
    backfill goes through ``process_posts`` / ``_process_batch`` instead.
    """
    if file_abs_path is None:
        logger.error("file_abs_path cannot be None")
        return

    file_path, file_name, extension = get_path_name_and_extension(file_abs_path)
    post = await posts.get_by_path(file_path, file_name, extension)
    if post is None:
        logger.info(f"Post not found in database: {file_abs_path}")
        return

    if post.sha256 and post.thumbhash:
        logger.info(f"Skipping post: {file_abs_path}")
        return

    if file_abs_path.suffix.lower() not in IMAGE_EXTS:
        logger.debug(f"Skipping non-image file: {file_abs_path}")
        return

    logger.info(f"Processing post: {file_abs_path}")

    try:
        basics = await asyncio.to_thread(_compute_basics_for, post, file_abs_path)
    except Exception as exc:
        if not post.sha256 and file_abs_path:
            with contextlib.suppress(OSError):
                await asyncio.to_thread(file_abs_path.unlink)
        logger.warning(f"Error processing file: {file_abs_path}: {exc}")
        return

    if basics is None:
        return

    await asyncio.to_thread(_persist_basics_batch, posts, [(post, file_abs_path, basics)])

    if basics["sha256"] is not None:
        await _run_gpu_pipeline(posts, vectors, tag_groups, post, file_abs_path)


# ─── Compute (per-image, runs in threads) ────────────────────────────────


def _compute_basics_for(post: Post, file_abs_path: Path) -> dict | None:
    """Compute sha256/thumbhash/dimensions/colors/dom_color for one image.

    Returns ``None`` if neither sha256 nor thumbhash is missing (nothing to do).
    Raises on real I/O / decode failures so the caller can decide what to do.
    """
    needs_sha256 = not post.sha256
    needs_thumbhash = not post.thumbhash
    if not needs_sha256 and not needs_thumbhash:
        return None

    with file_abs_path.open("rb") as f:
        file_data = f.read() if needs_sha256 else None
        f.seek(0)
        with Image.open(f) as img:
            img.verify()
            width, height = img.size
            relative = file_abs_path.relative_to(shared.target_dir)
            thumb_path = shared.thumbnails_dir / relative
            if not thumb_path.exists():
                thumb_path.parent.mkdir(parents=True, exist_ok=True)
                create_thumbnail(file_abs_path, thumb_path)
        f.seek(0)
        colors_ints, dom_lab = _extract_colors(post.id, f)

    return {
        "sha256": calculate_sha256(file_data) if (file_data and needs_sha256) else None,
        "size": file_abs_path.stat().st_size if needs_sha256 else None,
        "thumbhash": calculate_thumbhash(file_abs_path) if needs_thumbhash else None,
        "width": width,
        "height": height,
        "colors": colors_ints,
        "dominant_lab": dom_lab,
    }


# ─── Persist (batched DB write, runs in one thread) ──────────────────────


def _persist_basics_batch(
    posts: PostRepo,
    valid: list[tuple[Post, Any, dict]],
) -> None:
    """Write a batch of compute results in one round of executemany calls.

    DuckDB charges per-statement (and per-rewritten-row), so collapsing N
    posts x 4 UPDATEs into one ``executemany`` per logical write target is
    the main speedup over the row-by-row pipeline.
    """
    if not valid:
        return
    cur = posts.cur

    # Single UPDATE template covers every row regardless of which fields it
    # actually computed: COALESCE keeps the existing column value when the
    # new value is None.
    main_rows = [
        (
            b["width"],
            b["height"],
            b["sha256"],
            b["sha256"],  # second placeholder controls whether `size` updates
            b["size"],
            b["thumbhash"],
            post.id,
        )
        for post, _, b in valid
    ]
    cur.executemany(
        """
        UPDATE posts SET
            width = ?,
            height = ?,
            sha256 = COALESCE(?, sha256),
            size = CASE WHEN ? IS NULL THEN size ELSE ? END,
            thumbhash = COALESCE(?, thumbhash),
            updated_at = now()
        WHERE id = ?
        """,
        main_rows,
    )

    # dominant_color: HNSW-safe path (NULL → value only). Skip rows that
    # didn't compute a value at all.
    dom_rows = [
        (list(b["dominant_lab"]), post.id)
        for post, _, b in valid
        if b["dominant_lab"] is not None
    ]
    if dom_rows:
        cur.executemany(
            "UPDATE posts SET dominant_color = ? "
            "WHERE id = ? AND dominant_color IS NULL",
            dom_rows,
        )

    # post_has_color: replace the palette for every post that produced one.
    palette_post_ids = [post.id for post, _, b in valid if b["colors"]]
    if palette_post_ids:
        placeholders = ",".join("?" * len(palette_post_ids))
        cur.execute(
            f"DELETE FROM post_has_color WHERE post_id IN ({placeholders})",  # noqa: S608
            palette_post_ids,
        )
        color_rows = [
            (post.id, i, c)
            for post, _, b in valid
            for i, c in enumerate(b["colors"])
        ]
        cur.executemany(
            'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)',
            color_rows,
        )


# ─── GPU pipeline (per-image, sequential — single GPU) ───────────────────


async def _run_gpu_pipeline(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    post: Post,
    file_abs_path: Path,
) -> None:
    """Compute CLIP embedding and WDTagger tags for one freshly hashed post."""
    from ai.clip import calculate_image_features  # noqa: PLC0415  # lazy: defer ML stack load until first use

    features = await asyncio.to_thread(calculate_image_features, file_abs_path)
    embedding = features.cpu().numpy()[0].astype(np.float32)
    await vectors.upsert(post.id, embedding)

    tagger = get_tagger()
    resp = await asyncio.to_thread(tagger.tag, file_abs_path)
    new_rating = from_rating_to_int(resp.rating)
    if post.rating == 0 and new_rating != 0:
        await posts.update_field(post.id, "rating", new_rating)
    await attach_wdtagger_results(posts, tag_groups, post.id, resp, is_auto=True)


# ─── Color helpers ───────────────────────────────────────────────────────


def _rgb_to_lab(rgb_tuple: tuple[int, int, int]) -> np.ndarray:
    rgb_norm = np.array(rgb_tuple, dtype=np.float64) / 255.0
    return color.rgb2lab(rgb_norm.reshape(1, 1, 3)).reshape(3)


def _extract_colors(post_id: int, file: BufferedReader) -> tuple[list[int], np.ndarray | None]:
    """Return (palette_ints, dominant_color_lab)."""
    try:
        palette = get_palette_ints(file)
        file.seek(0)
        rgb_dom = get_dominant_color(file)
        lab = _rgb_to_lab(rgb_dom)
        return list(palette), lab
    except Exception as exc:
        logger.warning(f"Color extraction failed for post {post_id}: {exc}")
        return [], None
