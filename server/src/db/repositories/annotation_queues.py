"""Annotation queue repository: what to annotate next, fed by silva-side samplers.

Queues are write-once item lists (absolute posts or pairwise pairs); the UI
consumes them in position order and marks items done as judgements land.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from db.entities import AnnotationQueue
from db.helpers import fetch_all_dicts, fetch_one_as

if TYPE_CHECKING:
    import sqlite3

QUEUE_COLUMNS = "id, name, kind, dimensions, scale, created_at"
_ITEM_TABLES = {"absolute": "absolute_queue_items", "pairwise": "pairwise_queue_items"}
_POST_COLS = ("id", "file_path", "file_name", "extension", "sha256", "width", "height")


def _aliased_post_cols(table_alias: str, out_prefix: str) -> str:
    """``pa.id AS a_post_id, pa.file_path AS a_file_path, ...`` column list."""
    parts = [f"{table_alias}.id AS {out_prefix}post_id"]
    parts += [f"{table_alias}.{c} AS {out_prefix}{c}" for c in _POST_COLS[1:]]
    return ", ".join(parts)


class AnnotationQueueRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def create_absolute_queue(self, *, name: str, dimensions: list[str], scale: int, post_ids: list[int]) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'absolute', ?, ?)",
                [name, json.dumps(dimensions), scale],
            )
            qid = int(self.cur.lastrowid or 0)
            self.cur.executemany(
                "INSERT INTO absolute_queue_items (queue_id, position, post_id) VALUES (?, ?, ?)",
                [(qid, pos, pid) for pos, pid in enumerate(post_ids)],
            )
            return qid

        return await asyncio.to_thread(_impl)

    async def create_pairwise_queue(self, *, name: str, dimensions: list[str], pairs: list[tuple[int, int]]) -> int:
        def _impl() -> int:
            self.cur.execute(
                "INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES (?, 'pairwise', ?, NULL)",
                [name, json.dumps(dimensions)],
            )
            qid = int(self.cur.lastrowid or 0)
            self.cur.executemany(
                "INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b) VALUES (?, ?, ?, ?)",
                [(qid, pos, a, b) for pos, (a, b) in enumerate(pairs)],
            )
            return qid

        return await asyncio.to_thread(_impl)

    async def get(self, queue_id: int) -> AnnotationQueue | None:
        def _impl() -> AnnotationQueue | None:
            self.cur.execute(
                f"SELECT {QUEUE_COLUMNS} FROM annotation_queues WHERE id = ?",  # noqa: S608
                [queue_id],
            )
            return fetch_one_as(self.cur, AnnotationQueue)

        return await asyncio.to_thread(_impl)

    async def list_queues(self) -> list[tuple[AnnotationQueue, int, int]]:
        """Return ``(queue, total_items, done_items)`` for every queue, newest first."""

        def _impl() -> list[tuple[AnnotationQueue, int, int]]:
            self.cur.execute(f"SELECT {QUEUE_COLUMNS} FROM annotation_queues ORDER BY id DESC")  # noqa: S608
            queues = [AnnotationQueue.model_validate(row) for row in fetch_all_dicts(self.cur)]
            out: list[tuple[AnnotationQueue, int, int]] = []
            for q in queues:
                table = _ITEM_TABLES[q.kind]
                self.cur.execute(
                    f"SELECT COUNT(*), COALESCE(SUM(done), 0) FROM {table} WHERE queue_id = ?",  # noqa: S608
                    [q.id],
                )
                total, done = self.cur.fetchone()
                out.append((q, int(total), int(done)))
            return out

        return await asyncio.to_thread(_impl)

    async def next_absolute_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        def _impl() -> list[dict[str, Any]]:
            self.cur.execute(
                "SELECT i.position, p.id AS post_id, p.file_path, p.file_name, p.extension, p.sha256, p.width, p.height "
                "FROM absolute_queue_items i JOIN posts p ON p.id = i.post_id "
                "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
                [queue_id, limit],
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def next_pairwise_items(self, queue_id: int, *, limit: int = 20) -> list[dict[str, Any]]:
        def _impl() -> list[dict[str, Any]]:
            self.cur.execute(
                f"SELECT i.position, {_aliased_post_cols('pa', 'a_')}, {_aliased_post_cols('pb', 'b_')} "  # noqa: S608
                "FROM pairwise_queue_items i "
                "JOIN posts pa ON pa.id = i.post_a JOIN posts pb ON pb.id = i.post_b "
                "WHERE i.queue_id = ? AND i.done = 0 ORDER BY i.position LIMIT ?",
                [queue_id, limit],
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def mark_done(self, queue_id: int, *, kind: str, position: int) -> bool:
        table = _ITEM_TABLES[kind]

        def _impl() -> bool:
            self.cur.execute(
                f"UPDATE {table} SET done = 1 WHERE queue_id = ? AND position = ?",  # noqa: S608
                [queue_id, position],
            )
            return self.cur.rowcount > 0

        return await asyncio.to_thread(_impl)
