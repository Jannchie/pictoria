"""Basics worker: sha256 + arthash + dimensions + palette + dominant_color.

These stay bundled because all of them piggyback on a single file open /
PIL decode — splitting them would re-decode the same image up to four times.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image
from skimage import color

import shared
from db.helpers import sql_placeholders
from db.repositories.failures import WORKER_BASICS, FailureRepo, not_failed_clause
from processors.common import IMAGE_EXT_WHERE, build_image_items, drive
from shared import logger
from tools.colors import get_palette, rgb2int
from utils import (
    calculate_arthash,
    calculate_sha256,
    create_thumbnail_by_image,
)

if TYPE_CHECKING:
    from pathlib import Path

    from rich.progress import Progress

    from db.entities import Post
    from db.repositories.posts import PostRepo

BASICS_BATCH_SIZE = 32


async def run_basics_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill sha256 / arthash / dimensions / palette / dominant_color."""
    pending = await _list_basics_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_basics_batch(posts, batch_ids)

    await drive(progress, "Basics", pending, BASICS_BATCH_SIZE, _process)


async def _list_basics_pending(posts: PostRepo) -> list[int]:
    # When arthash is disabled, drop the ``arthash IS NULL`` predicate — otherwise
    # every legacy post whose only missing column is arthash would be selected
    # on every sync, but the worker would no-op on it (because _compute_basics_for
    # also short-circuits arthash), and the same ids would be re-picked next pass.
    arthash_clause = "" if shared.disable_arthash else "OR p.arthash IS NULL OR p.arthash = ''"

    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE (p.sha256 = ''
                {arthash_clause}
                OR p.dominant_color IS NULL)
              AND {IMAGE_EXT_WHERE}
              AND {not_failed_clause("p")}
            ORDER BY p.id
            """,  # noqa: S608
            [WORKER_BASICS],
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _process_basics_batch(posts: PostRepo, post_ids: list[int]) -> None:
    """Resolve paths, decode each image once, write back basics in one batch."""
    posts_map = await posts.get_many(post_ids)
    items = [(post, path) for _, post, path in build_image_items(posts_map, post_ids)]
    if not items:
        return

    raw_results = await asyncio.gather(
        *[asyncio.to_thread(_compute_basics_for, post, path) for post, path in items],
        return_exceptions=True,
    )
    valid: list[tuple[Post, Path, dict]] = []
    failed: list[tuple[int, str, str]] = []
    for (post, path), b in zip(items, raw_results, strict=True):
        if isinstance(b, BaseException):
            logger.warning(f"[basics] compute failed for {path}: {b}")
            failed.append((post.id, WORKER_BASICS, f"compute failed: {b}"))
            continue
        if b is None:
            continue
        # PIL decoded fine but colorthief couldn't extract a palette — other
        # basics fields still get persisted, but ``dominant_color`` stays
        # NULL. Without a failure row, the post would be re-selected on
        # every sync forever; the blacklist makes it one-shot.
        if b.get("color_error"):
            failed.append((post.id, WORKER_BASICS, f"color: {b['color_error']}"))
        valid.append((post, path, b))
    if valid:
        await asyncio.to_thread(_persist_basics_batch, posts, valid)
    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


# ─── Compute / persist helpers ───────────────────────────────────────────


def _compute_basics_for(post: Post, file_abs_path: Path) -> dict | None:
    """Compute sha256 / arthash / dimensions / palette / dominant_color.

    Returns ``None`` when everything is already filled in (nothing to do).
    Raises on real I/O / decode failures so callers can decide what to do.
    """
    needs_sha256 = not post.sha256
    needs_arthash = not shared.disable_arthash and not post.arthash
    needs_color = post.dominant_color is None
    if not (needs_sha256 or needs_arthash or needs_color):
        return None

    with file_abs_path.open("rb") as f:
        file_data = f.read() if needs_sha256 else None
        f.seek(0)
        # Note: no img.verify() here — verify() ignores LOAD_TRUNCATED_IMAGES
        # and rejects partially-downloaded files even though decode below
        # handles them fine. Any genuine "not an image" file will still
        # fail at Image.open() and bubble up to the batch caller.
        with Image.open(f) as img:
            width, height = img.size

            relative = file_abs_path.relative_to(shared.target_dir)
            thumb_path = shared.thumbnails_dir / relative
            if not thumb_path.exists():
                thumb_path.parent.mkdir(parents=True, exist_ok=True)
                create_thumbnail_by_image(img, thumb_path)

            arthash = calculate_arthash(img) if needs_arthash else None
            if needs_color:
                colors_ints, dom_lab, color_err = _extract_colors(post.id, img)
            else:
                colors_ints, dom_lab, color_err = [], None, None

    return {
        "sha256": calculate_sha256(file_data) if (file_data and needs_sha256) else None,
        "size": file_abs_path.stat().st_size if needs_sha256 else None,
        "arthash": arthash,
        "width": width,
        "height": height,
        "colors": colors_ints,
        "dominant_lab": dom_lab,
        "color_error": color_err,
    }


def _persist_basics_batch(
    posts: PostRepo,
    valid: list[tuple[Post, Any, dict]],
) -> None:
    """Write a batch of compute results in one round of executemany calls."""
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
            b["arthash"],
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
            arthash = COALESCE(?, arthash),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        main_rows,
    )

    # dominant_color: store as sqlite-vec serialized FLOAT[3] BLOB. Restrict
    # to NULL → value so we don't overwrite already-computed colors.
    import sqlite_vec  # noqa: PLC0415

    dom_rows = [(sqlite_vec.serialize_float32(list(b["dominant_lab"])), post.id) for post, _, b in valid if b["dominant_lab"] is not None]
    if dom_rows:
        cur.executemany(
            "UPDATE posts SET dominant_color = ? WHERE id = ? AND dominant_color IS NULL",
            dom_rows,
        )

    # post_has_color: replace the palette for every post that produced one.
    palette_post_ids = [post.id for post, _, b in valid if b["colors"]]
    if palette_post_ids:
        placeholders = sql_placeholders(palette_post_ids)
        cur.execute(
            f"DELETE FROM post_has_color WHERE post_id IN ({placeholders})",  # noqa: S608
            palette_post_ids,
        )
        color_rows = [(post.id, i, c) for post, _, b in valid for i, c in enumerate(b["colors"])]
        cur.executemany(
            'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)',
            color_rows,
        )


# ─── Color helpers ───────────────────────────────────────────────────────


def _rgb_to_lab(rgb_tuple: tuple[int, int, int]) -> np.ndarray:
    rgb_norm = np.array(rgb_tuple, dtype=np.float64) / 255.0
    return color.rgb2lab(rgb_norm.reshape(1, 1, 3)).reshape(3)


def _extract_colors(
    post_id: int,
    img: Image.Image,
) -> tuple[list[int], np.ndarray | None, str | None]:
    """Return (palette_ints, dominant_color_lab, error) from a decoded image.

    ColorThief's ``get_color`` is literally ``get_palette(...)[0]``, so the
    previous separate palette + dominant-color calls were doing the
    median-cut clustering twice. Compute the palette once, derive both
    outputs from it.

    The third tuple element is the colorthief error message when extraction
    failed (e.g. ``vbox1 not defined`` on degenerate single-colour images),
    or ``None`` on success. The caller uses this to permanently black-list
    the (post, basics) pair — without it, ``dominant_color IS NULL`` would
    re-select the post on every sync forever.
    """
    try:
        palette = get_palette(img)
    except Exception as exc:
        logger.warning(f"Color extraction failed for post {post_id}: {exc}")
        return [], None, str(exc)
    ints = [rgb2int(rgb) for rgb in palette]
    lab = _rgb_to_lab(palette[0]) if palette else None
    return ints, lab, None
