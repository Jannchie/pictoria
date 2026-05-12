"""Post-processing pipeline: sha256, thumbhash, embedding, colors, auto-tags.

Refactored from SQLAlchemy session to Native DuckDB Repository pattern.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING

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

    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo
    from db.repositories.vectors import VectorRepo

_background_tasks: set[asyncio.Task] = set()


async def sync_metadata(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
) -> None:
    """Schedule a background reconciliation of disk files vs DB rows."""
    loop = asyncio.get_event_loop()
    task = loop.create_task(_sync_metadata(posts, vectors, tag_groups))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _sync_metadata(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
) -> None:
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
        for p in pending:
            file_abs_path = (
                shared.target_dir / p["file_path"] / f"{p['file_name']}.{p['extension']}"
            )
            try:
                await process_post(posts, vectors, tag_groups, file_abs_path)
            except Exception:
                logger.exception(f"Failed to process post {p['id']}")
            progress.update(task, advance=1)


async def process_post(  # noqa: C901, PLR0915
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    file_abs_path: Path | None = None,
) -> None:
    """Process a single post: sha256, thumbhash, dimensions, embedding, tags."""
    if file_abs_path is None:
        logger.error("file_abs_path cannot be None")
        return

    file_path, file_name, extension = get_path_name_and_extension(file_abs_path)
    post = await posts.get_by_path(file_path, file_name, extension)
    if post is None:
        logger.info(f"Post not found in database: {file_abs_path}")
        return

    needs_sha256 = not post.sha256
    needs_thumbhash = not post.thumbhash
    if not needs_sha256 and not needs_thumbhash:
        logger.info(f"Skipping post: {file_abs_path}")
        return

    if file_abs_path.suffix.lower() not in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]:
        logger.debug(f"Skipping non-image file: {file_abs_path}")
        return

    logger.info(f"Processing post: {file_abs_path}")

    def _compute_basics() -> dict:
        with file_abs_path.open("rb") as f:
            file_data = f.read() if needs_sha256 else None
            f.seek(0)
            with Image.open(f) as img:
                img.verify()
                width, height = img.size
                # build thumbnail next to original (mirroring tree)
                relative = file_abs_path.relative_to(shared.target_dir)
                thumb_path = shared.thumbnails_dir / relative
                if not thumb_path.exists():
                    thumb_path.parent.mkdir(parents=True, exist_ok=True)
                    create_thumbnail(file_abs_path, thumb_path)
            f.seek(0)
            colors_ints, dom_lab = _extract_colors(post.id, f)
        thumbhash_val = calculate_thumbhash(file_abs_path) if needs_thumbhash else None
        sha = calculate_sha256(file_data) if (file_data and needs_sha256) else None
        size = file_abs_path.stat().st_size if needs_sha256 else None
        return {
            "sha256": sha,
            "size": size,
            "thumbhash": thumbhash_val,
            "width": width,
            "height": height,
            "colors": colors_ints,
            "dominant_lab": dom_lab,
        }

    try:
        basics = await asyncio.to_thread(_compute_basics)
    except Exception as exc:
        if needs_sha256 and file_abs_path:
            with contextlib.suppress(OSError):
                await asyncio.to_thread(file_abs_path.unlink)
        logger.warning(f"Error processing file: {file_abs_path}: {exc}")
        return

    def _persist_basics() -> None:
        cur = posts.cur
        cur.execute(
            "UPDATE posts SET width = ?, height = ? WHERE id = ?",
            [basics["width"], basics["height"], post.id],
        )
        if basics["sha256"] is not None:
            cur.execute(
                "UPDATE posts SET sha256 = ?, size = ? WHERE id = ?",
                [basics["sha256"], basics["size"], post.id],
            )
        if basics["thumbhash"] is not None:
            cur.execute(
                "UPDATE posts SET thumbhash = ? WHERE id = ?",
                [basics["thumbhash"], post.id],
            )
        if basics["dominant_lab"] is not None:
            cur.execute(
                "UPDATE posts SET dominant_color = ? WHERE id = ?",
                [list(basics["dominant_lab"]), post.id],
            )
        if basics["colors"]:
            cur.execute("DELETE FROM post_has_color WHERE post_id = ?", [post.id])
            for i, c in enumerate(basics["colors"]):
                cur.execute(
                    'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)',
                    [post.id, i, c],
                )

    await asyncio.to_thread(_persist_basics)

    if needs_sha256:
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
