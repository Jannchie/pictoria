"""WDTagger result persistence and the lazy model loader.

Persists tagger output (tags + group assignment + post links) for single
posts and batches; both paths share the canonical-tag-group resolution and
the same upsert SQL. The model itself is loaded once, on first use, behind
a thread lock (workers call ``get_tagger`` from ``asyncio.to_thread``).
"""

from __future__ import annotations

import asyncio
import threading
from functools import cache
from typing import TYPE_CHECKING

import shared

if TYPE_CHECKING:
    import sqlite3

    import wdtagger

    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo

TAG_GROUP_COLORS: dict[str, str] = {
    "general":   "#006192",
    "character": "#8243ca",
    "artist":    "#f30000",
    "copyright": "#00b300",
}


async def attach_wdtagger_results(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    post_id: int,
    result: wdtagger.Result,
    *,
    is_auto: bool = False,
) -> None:
    """Persist wdtagger output for a single post."""
    group_objs = await _resolve_canonical_tag_groups(tag_groups)
    await asyncio.to_thread(_persist_wdtagger_results, posts.cur, post_id, result, group_objs, is_auto)


async def attach_wdtagger_results_many(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    items: list[tuple[int, wdtagger.Result]],
    *,
    is_auto: bool = False,
) -> None:
    """Persist wdtagger output for a batch of posts in a single DB round-trip.

    Equivalent to calling :func:`attach_wdtagger_results` once per item, but
    folds all the per-row ``INSERT`` calls into three ``executemany`` calls so
    the batch only crosses the asyncio→thread boundary once.
    """
    if not items:
        return
    group_objs = await _resolve_canonical_tag_groups(tag_groups)
    await asyncio.to_thread(_persist_wdtagger_results_many, posts.cur, items, group_objs, is_auto)


async def _resolve_canonical_tag_groups(tag_groups: TagGroupRepo) -> dict[str, int]:
    """Return ``{group_name: id}`` for the four canonical groups.

    On startup ``shared.canonical_tag_groups`` is filled once by
    ``ensure_canonical_tag_groups_sync``; this fast-path skips the per-image
    ``ensure`` round-trips (4 SQL ops x every post in the library) that used
    to dominate tagger backfill time. Falls back to ``ensure`` if the cache
    is empty (single-image upload before startup populated the cache, tests,
    etc.).
    """
    cached = shared.canonical_tag_groups
    if cached and all(name in cached for name in TAG_GROUP_COLORS):
        return cached
    group_objs: dict[str, int] = {}
    for group_name, color in TAG_GROUP_COLORS.items():
        g = await tag_groups.ensure(group_name, color=color)
        group_objs[group_name] = g.id
    return group_objs


def _persist_wdtagger_results(
    cur: sqlite3.Cursor,
    post_id: int,
    result: wdtagger.Result,
    group_objs: dict[str, int],
    is_auto: bool,  # noqa: FBT001  # internal helper, keyword-only would force every caller to spell it
) -> None:
    general_set = set(result.general_tags)
    character_set = set(result.character_tags)
    all_names = general_set | character_set
    if not all_names:
        return

    _executemany_tag_upsert(cur, general_set, group_objs["general"])
    _executemany_tag_upsert(cur, character_set, group_objs["character"])
    cur.executemany(
        "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?) "
        "ON CONFLICT (post_id, tag_name) DO NOTHING",
        [(post_id, name, is_auto) for name in all_names],
    )


def _persist_wdtagger_results_many(
    cur: sqlite3.Cursor,
    items: list[tuple[int, wdtagger.Result]],
    group_objs: dict[str, int],
    is_auto: bool,  # noqa: FBT001  # mirrors public attach_wdtagger_results_many signature
) -> None:
    # Deduplicate tag names across the whole batch so the upsert only touches
    # each tag once even if many images share it.
    general_seen: set[str] = set()
    character_seen: set[str] = set()
    link_rows: list[tuple[int, str, bool]] = []
    for post_id, result in items:
        general_set = set(result.general_tags)
        character_set = set(result.character_tags)
        general_seen |= general_set
        character_seen |= character_set
        link_rows.extend((post_id, name, is_auto) for name in general_set | character_set)
    if not link_rows:
        return

    _executemany_tag_upsert(cur, general_seen, group_objs["general"])
    _executemany_tag_upsert(cur, character_seen, group_objs["character"])
    cur.executemany(
        "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?) "
        "ON CONFLICT (post_id, tag_name) DO NOTHING",
        link_rows,
    )


def _executemany_tag_upsert(cur: sqlite3.Cursor, names: set[str], group_id: int) -> None:
    if not names:
        return
    cur.executemany(
        "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE "
        "SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END",
        [(name, group_id) for name in names],
    )


# ─── wdtagger model loader (lazy) ──────────────────────────────────────
@cache
def _get_tagger() -> wdtagger.Tagger:
    import wdtagger  # noqa: PLC0415  # lazy: defer ML stack load until first use
    return wdtagger.Tagger(model_repo="SmilingWolf/wd-vit-large-tagger-v3")


_tagger_lock = threading.Lock()


def get_tagger():
    with _tagger_lock:
        return _get_tagger()
