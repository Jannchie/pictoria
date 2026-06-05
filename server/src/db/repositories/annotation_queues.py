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

    # ─── Sampling (queue auto-generation / streaming) ─────────────────
    #
    # Strategies run entirely on data pictoria already owns (old manual
    # score, embeddings, annotation events) — no external sampler needed.
    # Candidates must have an embedding (training joins it later), must not
    # be hidden near-duplicates, must not already be annotated in any of the
    # requested dimensions, and must not sit in an undone queue item.
    #
    # Performance: the embedding check is a vec0 virtual-table lookup, which
    # is NOT a cheap B-tree probe — putting it in the WHERE clause makes
    # SQLite run it once per posts row (~100k lookups, tens of seconds).
    # So sampling is two-phase: draw an oversized random candidate batch on
    # plain-table predicates only, then vec0-filter just that small batch.

    _CANDIDATE_WHERE = (
        "p.canonical_post_id IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM absolute_queue_items i WHERE i.post_id = p.id AND i.done = 0) "
        "AND NOT EXISTS (SELECT 1 FROM absolute_annotations a WHERE a.post_id = p.id AND a.dimension IN ({dims}))"
    )

    def _with_embedding(self, ids: list[int]) -> list[int]:
        """Keep only ids that have a SigLIP2 embedding (vec0 point lookups)."""
        out: list[int] = []
        for pid in ids:
            self.cur.execute("SELECT 1 FROM post_vectors_siglip2 WHERE post_id = ?", [pid])
            if self.cur.fetchone() is not None:
                out.append(pid)
        return out

    def _draw(self, *, extra_where: str, extra_params: list[Any], dimensions: list[str], n: int) -> list[int]:
        """Phase 1: random candidates on plain predicates; phase 2: vec0 filter.

        Oversamples 2x — the library's embedding coverage is near-total, so a
        single oversized draw is enough (no refill loop, YAGNI).
        """
        dims_ph = ",".join("?" * len(dimensions))
        where = self._CANDIDATE_WHERE.format(dims=dims_ph)
        self.cur.execute(
            f"SELECT p.id FROM posts p WHERE {where} {extra_where} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
            [*dimensions, *extra_params, n * 2],
        )
        candidates = [row[0] for row in self.cur.fetchall()]
        return self._with_embedding(candidates)[:n]

    async def sample_post_ids(self, *, count: int, strategy: str, dimensions: list[str]) -> list[int]:
        """Sample candidate post ids for absolute annotation."""

        def _impl() -> list[int]:
            if strategy == "stratified":
                # Even split across old manual score levels 1..5, random within
                # each level; top up with random candidates if levels run dry.
                per_level = max(1, count // 5)
                picked: list[int] = []
                for level in range(1, 6):
                    picked += self._draw(extra_where="AND p.score = ?", extra_params=[level], dimensions=dimensions, n=per_level)
                    if len(picked) >= count:
                        return picked[:count]
                fill = count - len(picked)
                if fill > 0:
                    not_in = ",".join("?" * len(picked)) or "NULL"
                    picked += self._draw(extra_where=f"AND p.id NOT IN ({not_in})", extra_params=list(picked), dimensions=dimensions, n=fill)
                return picked
            return self._draw(extra_where="", extra_params=[], dimensions=dimensions, n=count)

        return await asyncio.to_thread(_impl)

    async def sample_pairs(self, *, count: int, strategy: str = "random") -> list[tuple[int, int]]:
        """Sample disjoint random pairs for pairwise annotation."""
        del strategy  # only 'random' for now; signature is forward-compatible

        def _impl() -> list[tuple[int, int]]:
            self.cur.execute(
                "SELECT p.id FROM posts p "
                "WHERE p.canonical_post_id IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM pairwise_queue_items i WHERE (i.post_a = p.id OR i.post_b = p.id) AND i.done = 0) "
                "ORDER BY RANDOM() LIMIT ?",
                [count * 4],
            )
            candidates = [row[0] for row in self.cur.fetchall()]
            ids = self._with_embedding(candidates)[: count * 2]
            return [(ids[i], ids[i + 1]) for i in range(0, len(ids) - 1, 2)]

        return await asyncio.to_thread(_impl)

    async def sample_absolute_items(self, *, count: int, strategy: str, dimensions: list[str]) -> list[dict[str, Any]]:
        """Sample candidates with image fields — queue-less streaming annotation."""
        ids = await self.sample_post_ids(count=count, strategy=strategy, dimensions=dimensions)
        if not ids:
            return []

        def _impl() -> list[dict[str, Any]]:
            ph = ",".join("?" * len(ids))
            self.cur.execute(
                f"SELECT {_aliased_post_cols('p', '')} FROM posts p WHERE p.id IN ({ph})",  # noqa: S608
                ids,
            )
            return fetch_all_dicts(self.cur)

        return await asyncio.to_thread(_impl)

    async def sample_pairwise_items(self, *, count: int, strategy: str = "random") -> list[dict[str, Any]]:
        """Sample disjoint pairs with image fields for both sides — queue-less streaming."""
        pairs = await self.sample_pairs(count=count, strategy=strategy)
        if not pairs:
            return []

        def _impl() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for a, b in pairs:
                self.cur.execute(
                    f"SELECT {_aliased_post_cols('pa', 'a_')}, {_aliased_post_cols('pb', 'b_')} "  # noqa: S608
                    "FROM posts pa, posts pb WHERE pa.id = ? AND pb.id = ?",
                    [a, b],
                )
                out += fetch_all_dicts(self.cur)
            return out

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
