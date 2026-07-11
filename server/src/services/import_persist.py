"""Shared two-phase persistence skeleton for the image importers.

Both ``danbooru_import`` and ``gallery_dl_import`` land new posts + their tags
the same way: normalise each source record into a :class:`NormalizedPostRow`,
then run two short, independently-retried transactions on a *worker-thread*
SQLite connection — tags first, posts + ``post_has_tag`` second. The only real
difference between the two callers is where the row fields come from (a
``DanbooruPost`` vs a ``GalleryDLItem``), so that mapping stays in each importer
and everything below is shared.

Persist always happens AFTER the files are on disk (see the importer docstrings):
a post row must never exist before its file, or the sync reconciler's
``remove_deleted_files`` races the throttled download and deletes the
just-committed post mid-flight. This module is downstream of that ordering — it
only ever receives rows whose bytes already landed.
"""

from __future__ import annotations

import contextlib
import sqlite3
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from shared import logger

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime


@dataclass
class NormalizedPostRow:
    """One image ready to persist, in the ``posts`` table's own terms.

    The fields are exactly the ``INSERT INTO posts(...)`` column list both
    importers already used (``file_path``, ``file_name``, ``extension``,
    ``source``, ``rating``, ``published_at``) plus the post's ``{tag_name:
    group_id}`` map. Callers do all source-specific work — id stringification,
    source resolution, rating coercion, tag/group flattening — before building
    this, so the persistence core stays format-agnostic.
    """

    file_path: str
    file_name: str
    extension: str
    source: str
    rating: int
    # danbooru hands sqlite3 a datetime (bound via the default adapter, as it
    # always did); gallery-dl passes an already-formatted string.
    published_at: str | datetime | None
    tags: dict[str, int] = field(default_factory=dict)


def persist_posts_with_tags(db: Any, rows: list[NormalizedPostRow]) -> list[int]:
    """Persist ``rows`` + their tags in two transactions; return the post ids.

    Called on a pool worker thread — ``db.cursor()`` therefore returns a cursor
    on *this worker thread's* SQLite connection, not the event-loop thread's.
    That isolation matters: transactions in sqlite3 are connection-scoped, so if
    all concurrent requests shared one connection, one worker's ``_safe_rollback``
    could (and did) rip a sibling worker's in-flight BEGIN out from under it —
    the ``cannot commit - no transaction is active`` failure mode.

    Split rationale: when concurrent import requests all insert overlapping tags,
    the commit-time uniqueness check on ``tags(name)`` aborts one of them. Running
    tag inserts in their own short transaction keeps that retry surface tiny and
    prevents replay of the (much larger) posts + post_has_tag work each time tags
    happen to conflict.

    Each transaction uses ON CONFLICT for in-snapshot duplicates and a bounded
    retry loop for commit-time conflicts that only show up against rows committed
    by other transactions after our snapshot was taken.
    """
    if not rows:
        return []
    cur = db.cursor()
    try:
        # Phase A: globally-deduped tag upsert in its own short transaction.
        all_tags: dict[str, int] = {}
        for row in rows:
            for name, gid in row.tags.items():
                all_tags.setdefault(name, gid)
        if all_tags:
            _run_with_retry(cur, "tags", lambda: _insert_tags_tx(cur, all_tags))

        # Phase B: posts + post_has_tag in their own transaction. The tags they
        # reference are now committed by phase A, so concurrent writers can't
        # make this transaction wait on them. ``result`` is reassigned per
        # attempt so only the successful run's ids survive a mid-flight retry.
        result: dict[str, list[int]] = {"ids": []}

        def _insert_posts() -> None:
            result["ids"] = _insert_posts_tx(cur, rows)

        _run_with_retry(cur, "posts", _insert_posts)
        return result["ids"]
    finally:
        cur.close()


def _run_with_retry(
    cur: sqlite3.Cursor,
    label: str,
    fn: Callable[[], None],
    *,
    max_attempts: int = 5,
) -> None:
    """Retry on SQLite ``database is locked`` while another writer holds it.

    With WAL mode and a single backend process the writer lock is short-lived,
    but the startup backfill task can collide with import requests; retry a few
    times before giving up.
    """
    for attempt in range(1, max_attempts + 1):
        try:
            fn()
        except sqlite3.OperationalError as exc:
            _safe_rollback(cur)
            msg = str(exc).lower()
            if "locked" not in msg and "busy" not in msg:
                raise
            if attempt == max_attempts:
                raise
            logger.warning(
                f"Import {label} write contention (attempt {attempt}/{max_attempts}): {exc}; retrying",
            )
        except Exception:
            _safe_rollback(cur)
            raise
        else:
            return


def _insert_tags_tx(cur: sqlite3.Cursor, all_tags: dict[str, int]) -> None:
    cur.execute("BEGIN")
    cur.executemany(
        "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
        list(all_tags.items()),
    )
    cur.execute("COMMIT")


def _insert_posts_tx(cur: sqlite3.Cursor, rows: list[NormalizedPostRow]) -> list[int]:
    cur.execute("BEGIN")
    post_tag_pairs: list[tuple[int, dict[str, int]]] = []
    for row in rows:
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
            [row.file_path, row.file_name, row.extension, row.source, row.rating, row.published_at],
        )
        # RETURNING fires for both INSERT (new post) and the DO UPDATE branch
        # (a pre-existing tag-less row being backfilled), so we get the id
        # either way and the post_has_tag upsert below attaches the tags.
        fetched = cur.fetchone()
        if fetched:
            post_tag_pairs.append((int(fetched[0]), row.tags))

    # (post_id, tag_name) is unique within this batch — each post_id appears
    # once and per-post names were deduped via dict when the row was built.
    post_tag_rows = [(post_id, name) for post_id, tag_map in post_tag_pairs for name in tag_map]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
            post_tag_rows,
        )
    cur.execute("COMMIT")
    return [post_id for post_id, _ in post_tag_pairs]


def _safe_rollback(cur: sqlite3.Cursor) -> None:
    """ROLLBACK that swallows the 'no transaction is active' case."""
    with contextlib.suppress(sqlite3.OperationalError):
        cur.execute("ROLLBACK")
