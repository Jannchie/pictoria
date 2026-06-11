"""FailureRepo — async Repository over ``post_process_failures``.

A per-(post, worker) blacklist of one-shot processing failures. The backfill
workers' "pending" predicates ``AND NOT EXISTS`` against this table so a post
that fails permanently (corrupt image, single-colour palette, ...) is dropped
from the pending set instead of being retried every sync.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3

# Worker-bucket keys. These must match what the ``record_failures`` write
# sites in ``processors/`` record — defining them once here keeps the
# pending-query blacklist predicates from drifting away from the writes.
WORKER_BASICS = "basics"
WORKER_TAGGER = "tagger"
WORKER_WAIFU = "waifu"
WORKER_EMBEDDING_SIGLIP2 = "embedding:siglip2"


def aesthetic_worker(scorer: str) -> str:
    """Worker-bucket key for a generic aesthetic scorer, e.g. ``aesthetic:silva``."""
    return f"aesthetic:{scorer}"


def not_failed_clause(alias: str = "p") -> str:
    """SQL predicate excluding posts blacklisted for one worker bucket.

    Returns a ``NOT EXISTS`` fragment over ``post_process_failures`` (see
    migration 0002_post_process_failures.sql) with a single ``?`` placeholder;
    the caller appends the worker key to its params. ``alias`` is the posts
    table alias in the enclosing query.
    """
    # ``alias`` only ever comes from code-level literals (an identifier can't
    # be a placeholder); the worker key itself stays a bound parameter.
    return (
        "NOT EXISTS (SELECT 1 FROM post_process_failures f "  # noqa: S608
        f"WHERE f.post_id = {alias}.id AND f.worker = ?)"
    )


class FailureRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def record_failures(self, rows: list[tuple[int, str, str]]) -> None:
        """Mark ``(post_id, worker, error_message)`` triples as permanently failed.

        Uses INSERT OR IGNORE so re-recording the same failure (e.g. when old
        data is reprocessed after a deliberate retry-then-fail-again cycle that
        *didn't* delete the existing row) is a no-op rather than an integrity
        error.
        """
        if not rows:
            return

        def _impl() -> None:
            self.cur.executemany(
                "INSERT OR IGNORE INTO post_process_failures "
                "(post_id, worker, error) VALUES (?, ?, ?)",
                rows,
            )

        await asyncio.to_thread(_impl)
