"""WDTagger worker: backfill auto-tags (and rating, when unset) per post."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from PIL import UnidentifiedImageError

from db.helpers import sql_placeholders
from db.repositories.failures import WORKER_TAGGER, FailureRepo, not_failed_clause
from processors.common import FALLBACK_MINI_BATCH_SIZE, IMAGE_EXT_WHERE, build_image_items, drive
from services.wd_tagging import attach_wdtagger_results, attach_wdtagger_results_many, get_tagger
from shared import logger
from utils import from_rating_to_int

if TYPE_CHECKING:
    from pathlib import Path

    from rich.progress import Progress

    from db.entities import Post
    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo

# WDTagger (wd-vit-large) runs on GPU; batch=32 keeps it saturated on a
# single 30xx-class card.
TAGGER_BATCH_SIZE = 32


async def run_tagger_worker(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill WDTagger auto-tags (and rating, if unset) per post."""
    pending = await _list_tagger_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_tagger_batch(posts, tag_groups, batch_ids)

    await drive(
        progress,
        "Tags",
        pending,
        TAGGER_BATCH_SIZE,
        _process,
        gpu_adaptive=True,
    )


async def _list_tagger_pending(posts: PostRepo) -> list[int]:
    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE NOT EXISTS (
                SELECT 1 FROM post_has_tag pht
                WHERE pht.post_id = p.id AND pht.is_auto = 1
            )
              AND {IMAGE_EXT_WHERE}
              AND {not_failed_clause("p")}
            ORDER BY p.id
            """,  # noqa: S608
            [WORKER_TAGGER],
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _process_tagger_batch(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    post_ids: list[int],
) -> None:
    tagger = get_tagger()
    posts_map = await posts.get_many(post_ids)
    items = build_image_items(posts_map, post_ids)
    if not items:
        return

    paths = [p for _, _, p in items]
    try:
        results = await asyncio.to_thread(tagger.tag, paths)
    except Exception as exc:
        # WDTagger collates the whole list before running; one bad image kills
        # the batch. Try mini-batches first to keep the GPU usefully busy, and
        # only drop the bad mini-batch to per-image.
        logger.warning(
            f"[tagger] batch failed ({exc!s}); retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
        await _tagger_fallback_mini_batch(posts, tag_groups, items)
        return

    rating_updates: list[tuple[int, int]] = []
    tag_items: list[tuple[int, Any]] = []
    failed: list[tuple[int, str, str]] = []
    early_failed: set[int] = set()
    for (pid, post, _), resp in zip(items, results, strict=True):
        # An empty result would leave post_has_tag untouched, so the
        # post stays pending forever. Black-list it instead — re-running
        # would just produce the same empty response.
        if not resp.general_tags and not resp.character_tags:
            failed.append((pid, WORKER_TAGGER, "no auto tags produced"))
            early_failed.add(pid)
            continue
        new_rating = from_rating_to_int(resp.rating)
        if post.rating == 0 and new_rating != 0:
            rating_updates.append((pid, new_rating))
        tag_items.append((pid, resp))

    if rating_updates:
        await asyncio.to_thread(_update_ratings, posts, rating_updates)
    await attach_wdtagger_results_many(posts, tag_groups, tag_items, is_auto=True)

    # Post-persist sanity check: ``attach_wdtagger_results_many`` issues
    # ``INSERT ... ON CONFLICT (post_id, tag_name) DO NOTHING``, so when
    # *every* tag the tagger produced for a post was already present as a
    # manual (``is_auto=0``) row — common for Danbooru-imported images —
    # zero ``is_auto=1`` rows get created and the pending predicate
    # re-selects the post on every sync. Black-list those too: re-running
    # the tagger produces the same shadowed result.
    attempted = [pid for pid, _, _ in items if pid not in early_failed]
    if attempted:
        shadowed = await _find_posts_without_auto_tags(posts, attempted)
        failed.extend((pid, WORKER_TAGGER, "all auto tags shadowed by manual tags") for pid in shadowed)

    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


async def _find_posts_without_auto_tags(posts: PostRepo, post_ids: list[int]) -> list[int]:
    """Return ids from ``post_ids`` that still have no ``is_auto=1`` row.

    Used as a post-persist verification step in the tagger workers: the
    INSERT-OR-NOTHING semantics of ``post_has_tag`` silently swallow inserts
    that collide with pre-existing manual tags, so the auto-tag rows aren't
    materialised even though the tagger did run.
    """

    def _impl() -> list[int]:
        placeholders = sql_placeholders(post_ids)
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE p.id IN ({placeholders})
              AND NOT EXISTS (
                SELECT 1 FROM post_has_tag pht
                WHERE pht.post_id = p.id AND pht.is_auto = 1
              )
            """,  # noqa: S608
            post_ids,
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _tagger_fallback_mini_batch(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    items: list[tuple[int, Post, Path]],
) -> None:
    """Retry tagger in mini-batches; only the failing one drops to per-image."""
    tagger = get_tagger()
    failed: list[tuple[int, str, str]] = []
    persisted: list[int] = []
    rating_updates: list[tuple[int, int]] = []
    tag_items: list[tuple[int, Any]] = []

    for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
        chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
        chunk_paths = [p for _, _, p in chunk]
        try:
            results = await asyncio.to_thread(tagger.tag, chunk_paths)
        except Exception as exc:
            logger.warning(
                f"[tagger] mini-batch failed ({exc!s}); falling back per-image",
            )
            await _tagger_per_image(
                tagger,
                posts,
                tag_groups,
                chunk,
                failed,
                persisted,
            )
            continue
        for (pid, post, _), resp in zip(chunk, results, strict=True):
            if not resp.general_tags and not resp.character_tags:
                failed.append((pid, WORKER_TAGGER, "no auto tags produced"))
                continue
            new_rating = from_rating_to_int(resp.rating)
            if post.rating == 0 and new_rating != 0:
                rating_updates.append((pid, new_rating))
            tag_items.append((pid, resp))
            persisted.append(pid)

    if rating_updates:
        await asyncio.to_thread(_update_ratings, posts, rating_updates)
    if tag_items:
        await attach_wdtagger_results_many(posts, tag_groups, tag_items, is_auto=True)
    if persisted:
        shadowed = await _find_posts_without_auto_tags(posts, persisted)
        failed.extend((pid, WORKER_TAGGER, "all auto tags shadowed by manual tags") for pid in shadowed)
    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


async def _tagger_per_image(  # noqa: PLR0913
    tagger: Any,
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    items: list[tuple[int, Post, Path]],
    failed: list[tuple[int, str, str]],
    persisted: list[int],
) -> None:
    for pid, post, abs_path in items:
        try:
            resp = await asyncio.to_thread(tagger.tag, abs_path)
            if not resp.general_tags and not resp.character_tags:
                failed.append((pid, WORKER_TAGGER, "no auto tags produced"))
                continue
            new_rating = from_rating_to_int(resp.rating)
            if post.rating == 0 and new_rating != 0:
                await posts.update_field(pid, "rating", new_rating)
            await attach_wdtagger_results(posts, tag_groups, pid, resp, is_auto=True)
            persisted.append(pid)
        except (UnidentifiedImageError, OSError) as exc:
            logger.warning(f"[tagger] skipping unreadable image {pid} ({abs_path}): {exc}")
            failed.append((pid, WORKER_TAGGER, f"{type(exc).__name__}: {exc}"))
        except Exception as exc:
            logger.exception(f"[tagger] post {pid} ({abs_path})")
            failed.append((pid, WORKER_TAGGER, f"{type(exc).__name__}: {exc}"))


def _update_ratings(posts: PostRepo, updates: list[tuple[int, int]]) -> None:
    posts.cur.executemany(
        "UPDATE posts SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [(rating, pid) for pid, rating in updates],
    )
