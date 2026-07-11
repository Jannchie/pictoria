"""WDTagger worker: backfill auto-tags (and rating, when unset) per post."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from db.helpers import sql_placeholders
from db.repositories.failures import WORKER_TAGGER, not_failed_clause
from processors.common import IMAGE_EXT_WHERE, build_image_items, record_pair_failures, run_batch_with_fallback
from services.wd_tagging import attach_wdtagger_results_many, get_tagger
from utils import from_rating_to_int

if TYPE_CHECKING:
    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo

# WDTagger (wd-vit-large) runs on GPU; batch=32 keeps it saturated on a
# single 30xx-class card.
TAGGER_BATCH_SIZE = 32


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


def _no_tags_reason(_pid: int, resp: Any) -> str | None:
    """Reject an empty tagger response so it's blacklisted, not silently dropped.

    An empty result would leave ``post_has_tag`` untouched, so the post stays
    pending forever; re-running would just produce the same empty response.
    Passed as ``run_batch_with_fallback``'s ``reject_reason`` so this check runs
    identically at the full-batch, mini-batch, and per-image levels.
    """
    if not resp.general_tags and not resp.character_tags:
        return "no auto tags produced"
    return None


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

    # The shared batch → mini-batch → per-image ladder handles WDTagger's
    # "one bad image kills the collated batch" failure mode; ``reject_reason``
    # folds the empty-response blacklist into every level of it.
    successes, failures = await run_batch_with_fallback(
        tagger.tag,
        [(pid, path) for pid, _, path in items],
        worker_label=WORKER_TAGGER,
        reject_reason=_no_tags_reason,
    )

    rating_updates: list[tuple[int, int]] = []
    tag_items: list[tuple[int, Any]] = []
    for pid, resp in successes:
        new_rating = from_rating_to_int(resp.rating)
        if posts_map[pid].rating == 0 and new_rating != 0:
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
    persisted = [pid for pid, _ in successes]
    if persisted:
        shadowed = await _find_posts_without_auto_tags(posts, persisted)
        failures.extend((pid, "all auto tags shadowed by manual tags") for pid in shadowed)

    await record_pair_failures(posts.cur, WORKER_TAGGER, failures)


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


def _update_ratings(posts: PostRepo, updates: list[tuple[int, int]]) -> None:
    posts.cur.executemany(
        "UPDATE posts SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [(rating, pid) for pid, rating in updates],
    )
