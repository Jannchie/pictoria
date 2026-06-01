"""VectorRepo — async Repository over post_vectors_siglip2 (SigLIP 2 image embeddings).

``post_vectors_siglip2`` is a sqlite-vec ``vec0`` virtual table; KNN queries
use the ``MATCH`` operator with a ``k = N`` constraint, which sqlite-vec
recognises and routes through its native nearest-neighbour search.

Vector serialization goes through ``sqlite_vec.serialize_float32`` (a
little-endian float32 BLOB); reads go through the inverse decoder below.
"""

from __future__ import annotations

import asyncio
import struct
from typing import TYPE_CHECKING

import sqlite_vec

from db import SimilarImageResult
from db.helpers import fetch_all_dicts, sql_placeholders

if TYPE_CHECKING:
    import sqlite3

    import numpy as np


# Table names may only come from this code-level allowlist: they are
# interpolated into SQL strings (a placeholder can't stand in for an
# identifier), so the set is sealed to keep any external input out of the
# table name. The value is the vec0 table's dimensionality.
_ALLOWED_TABLES: dict[str, int] = {
    "post_vectors_siglip2": 1152,
}


def _decode_vec_blob(value: bytes | bytearray | memoryview) -> list[float]:
    raw = bytes(value)
    n = len(raw) // 4
    return list(struct.unpack(f"{n}f", raw))


class VectorRepo:
    def __init__(
        self,
        cur: sqlite3.Cursor,
        *,
        table: str = "post_vectors_siglip2",
        dim: int | None = None,
    ) -> None:
        if table not in _ALLOWED_TABLES:
            msg = f"unknown vector table: {table!r}"
            raise ValueError(msg)
        self.cur = cur
        self.table = table
        self.dim = dim if dim is not None else _ALLOWED_TABLES[table]

    async def get(self, post_id: int) -> list[float] | None:
        def _impl() -> list[float] | None:
            self.cur.execute(
                f"SELECT embedding FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
            row = self.cur.fetchone()
            if not row:
                return None
            return _decode_vec_blob(row[0])

        return await asyncio.to_thread(_impl)

    async def get_many(self, post_ids: list[int]) -> dict[int, list[float]]:
        """Batch-fetch embeddings by post_id; ids without a vector are absent."""

        def _impl() -> dict[int, list[float]]:
            if not post_ids:
                return {}
            placeholders = sql_placeholders(post_ids)
            self.cur.execute(
                f"SELECT post_id, embedding FROM {self.table} "  # noqa: S608
                f"WHERE post_id IN ({placeholders})",
                post_ids,
            )
            return {pid: _decode_vec_blob(blob) for pid, blob in self.cur.fetchall()}

        return await asyncio.to_thread(_impl)

    async def upsert(self, post_id: int, embedding: np.ndarray | list[float]) -> None:
        """Insert or replace an embedding for ``post_id``.

        Unlike the DuckDB era (where HNSW tolerated neither DELETE nor UPDATE
        on the indexed column without index corruption), sqlite-vec's vec0
        handles INSERT-OR-REPLACE cleanly via DELETE + INSERT under the hood.
        """
        emb = embedding if isinstance(embedding, list) else embedding.tolist()
        if len(emb) != self.dim:
            msg = f"{self.table}: expected dim {self.dim}, got {len(emb)}"
            raise ValueError(msg)
        blob = sqlite_vec.serialize_float32(emb)

        def _impl() -> None:
            # vec0 doesn't support ON CONFLICT, so emulate UPSERT manually.
            self.cur.execute(
                f"DELETE FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
            self.cur.execute(
                f"INSERT INTO {self.table}(post_id, embedding) VALUES (?, ?)",  # noqa: S608
                [post_id, blob],
            )

        await asyncio.to_thread(_impl)

    async def delete(self, post_id: int) -> None:
        def _impl() -> None:
            self.cur.execute(
                f"DELETE FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )

        await asyncio.to_thread(_impl)

    async def similar(
        self,
        embedding: np.ndarray | list[float],
        *,
        limit: int = 100,
        skip_self: bool = True,
    ) -> list[SimilarImageResult]:
        """Top-N similar posts ordered by cosine distance ascending."""
        emb = embedding if isinstance(embedding, list) else embedding.tolist()
        if len(emb) != self.dim:
            msg = f"{self.table}: expected dim {self.dim}, got {len(emb)}"
            raise ValueError(msg)
        blob = sqlite_vec.serialize_float32(emb)
        fetch_limit = limit + (1 if skip_self else 0)

        def _impl() -> list[SimilarImageResult]:
            self.cur.execute(
                f"""
                SELECT post_id, distance
                FROM {self.table}
                WHERE embedding MATCH ? AND k = ?
                ORDER BY distance
                """,  # noqa: S608
                [blob, fetch_limit],
            )
            rows = fetch_all_dicts(self.cur)
            if skip_self and rows:
                rows = rows[1:]
            return [SimilarImageResult(**r) for r in rows[:limit]]

        return await asyncio.to_thread(_impl)

    async def similar_to_post(
        self,
        post_id: int,
        *,
        limit: int = 100,
    ) -> list[SimilarImageResult]:
        """Find posts similar to ``post_id`` in a single DB hop.

        Equivalent to ``similar(await self.get(post_id), skip_self=True)``
        but avoids the extra round-trip + Python-side blob ↔ list conversion
        by feeding the source row's blob straight into the MATCH query via
        a subselect. Returns ``[]`` when the source has no embedding.
        """
        fetch_limit = limit + 1

        def _impl() -> list[SimilarImageResult]:
            # vec0's MATCH rejects NULL as the query vector with a hard
            # OperationalError, so short-circuit when the source post has
            # no embedding instead of letting the inner subselect bubble
            # up a confusing schema-level error.
            self.cur.execute(
                f"SELECT 1 FROM {self.table} WHERE post_id = ?",  # noqa: S608
                [post_id],
            )
            if self.cur.fetchone() is None:
                return []
            self.cur.execute(
                f"""
                SELECT post_id, distance
                FROM {self.table}
                WHERE embedding MATCH (
                    SELECT embedding FROM {self.table} WHERE post_id = ?
                ) AND k = ?
                ORDER BY distance
                """,  # noqa: S608
                [post_id, fetch_limit],
            )
            rows = fetch_all_dicts(self.cur)
            # The source row itself comes back first (distance ~= 0); drop it.
            filtered = [r for r in rows if r["post_id"] != post_id]
            return [SimilarImageResult(**r) for r in filtered[:limit]]

        return await asyncio.to_thread(_impl)

    async def list_missing_post_ids(
        self,
        *,
        image_exts: list[str] | None = None,
        worker: str = "embedding",
    ) -> list[int]:
        """Return post ids that don't yet have an embedding in ``self.table``.

        ``image_exts`` (without leading dot, e.g. ``['jpg','png',...]``)
        narrows the pending set to image rows — non-image posts would just
        be filtered out one-by-one in the worker, but would still inflate
        the progress total. Passing the list lets the DB do that filter.

        ``worker`` selects which ``post_process_failures`` bucket to honour as
        a one-shot blacklist; the CLIP table uses ``"embedding"`` (default),
        the SigLIP 2 table uses ``"embedding:siglip2"`` so each has its own
        failure log.
        """

        def _impl() -> list[int]:
            # NOT EXISTS clause skips posts already permanently failed by the
            # embedding worker (see migration 0002_post_process_failures.sql).
            blacklist_clause = (
                "AND NOT EXISTS ("
                "SELECT 1 FROM post_process_failures f "
                "WHERE f.post_id = p.id AND f.worker = ?)"
            )
            if image_exts:
                # The `?` placeholder count is derived from len(image_exts);
                # ext strings flow through cur.execute params, never into SQL.
                placeholders = sql_placeholders(image_exts)
                ext_clause = f"AND LOWER(p.extension) IN ({placeholders})"
                self.cur.execute(
                    f"SELECT p.id FROM posts p "  # noqa: S608
                    f"LEFT JOIN {self.table} pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL "
                    + ext_clause + " " + blacklist_clause
                    + " ORDER BY p.id",
                    [*image_exts, worker],
                )
            else:
                self.cur.execute(
                    f"SELECT p.id FROM posts p "  # noqa: S608
                    f"LEFT JOIN {self.table} pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL " + blacklist_clause
                    + " ORDER BY p.id",
                    [worker],
                )
            return [r[0] for r in self.cur.fetchall()]

        return await asyncio.to_thread(_impl)
