"""ColorRepo — async Repository over ``post_has_color``.

The dominant-color palette is read-only from the API's perspective (it's
written by the basics backfill worker via raw SQL). The query layer needs it
batched per post for read-model assembly, so the only method here is the
synchronous ``fetch_by_ids`` helper, called from inside the query layer's
``asyncio.to_thread`` block.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3


class ColorRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    def fetch_by_ids(self, ids: list[int]) -> dict[int, list[dict]]:
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        self.cur.execute(
            f'SELECT post_id, "order", color FROM post_has_color '  # noqa: S608
            f'WHERE post_id IN ({placeholders}) ORDER BY post_id, "order"',
            ids,
        )
        result: dict[int, list[dict]] = {}
        for pid, order, color in self.cur.fetchall():
            result.setdefault(pid, []).append({"order": order, "color": color})
        return result
