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
