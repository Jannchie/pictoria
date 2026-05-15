"""VectorRepo — async Repository over post_vectors (CLIP image embeddings).

``post_vectors`` is a sqlite-vec ``vec0`` virtual table; KNN queries use
the ``MATCH`` operator with a ``k = N`` constraint, which sqlite-vec
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
from db.helpers import fetch_all_dicts

if TYPE_CHECKING:
    import sqlite3

    import numpy as np

EMBED_DIM = 768


def _decode_vec_blob(value: bytes | bytearray | memoryview) -> list[float]:
    raw = bytes(value)
    n = len(raw) // 4
    return list(struct.unpack(f"{n}f", raw))


class VectorRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def get(self, post_id: int) -> list[float] | None:
        def _impl() -> list[float] | None:
            self.cur.execute(
                "SELECT embedding FROM post_vectors WHERE post_id = ?",
                [post_id],
            )
            row = self.cur.fetchone()
            if not row:
                return None
            return _decode_vec_blob(row[0])

        return await asyncio.to_thread(_impl)

    async def upsert(self, post_id: int, embedding: np.ndarray | list[float]) -> None:
        """Insert or replace an embedding for ``post_id``.

        Unlike the DuckDB era (where HNSW tolerated neither DELETE nor UPDATE
        on the indexed column without index corruption), sqlite-vec's vec0
        handles INSERT-OR-REPLACE cleanly via DELETE + INSERT under the hood.
        """
        emb = embedding if isinstance(embedding, list) else embedding.tolist()
        blob = sqlite_vec.serialize_float32(emb)

        def _impl() -> None:
            # vec0 doesn't support ON CONFLICT, so emulate UPSERT manually.
            self.cur.execute(
                "DELETE FROM post_vectors WHERE post_id = ?",
                [post_id],
            )
            self.cur.execute(
                "INSERT INTO post_vectors(post_id, embedding) VALUES (?, ?)",
                [post_id, blob],
            )

        await asyncio.to_thread(_impl)

    async def delete(self, post_id: int) -> None:
        def _impl() -> None:
            self.cur.execute(
                "DELETE FROM post_vectors WHERE post_id = ?",
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
        blob = sqlite_vec.serialize_float32(emb)
        fetch_limit = limit + (1 if skip_self else 0)

        def _impl() -> list[SimilarImageResult]:
            self.cur.execute(
                """
                SELECT post_id, distance
                FROM post_vectors
                WHERE embedding MATCH ? AND k = ?
                ORDER BY distance
                """,
                [blob, fetch_limit],
            )
            rows = fetch_all_dicts(self.cur)
            if skip_self and rows:
                rows = rows[1:]
            return [SimilarImageResult(**r) for r in rows[:limit]]

        return await asyncio.to_thread(_impl)

    async def list_missing_post_ids(self, *, image_exts: list[str] | None = None) -> list[int]:
        """Return post ids that don't yet have an embedding.

        ``image_exts`` (without leading dot, e.g. ``['jpg','png',...]``)
        narrows the pending set to image rows — non-image posts would just
        be filtered out one-by-one in the worker, but would still inflate
        the progress total. Passing the list lets the DB do that filter.
        """

        def _impl() -> list[int]:
            # NOT EXISTS clause skips posts already permanently failed by the
            # embedding worker (see migration 0002_post_process_failures.sql).
            blacklist_clause = (
                "AND NOT EXISTS ("
                "SELECT 1 FROM post_process_failures f "
                "WHERE f.post_id = p.id AND f.worker = 'embedding')"
            )
            if image_exts:
                # The `?` placeholder count is derived from len(image_exts);
                # ext strings flow through cur.execute params, never into SQL.
                placeholders = ",".join("?" * len(image_exts))
                ext_clause = f"AND LOWER(p.extension) IN ({placeholders})"
                self.cur.execute(
                    "SELECT p.id FROM posts p "  # noqa: S608
                    "LEFT JOIN post_vectors pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL "
                    + ext_clause + " " + blacklist_clause
                    + " ORDER BY p.id",
                    image_exts,
                )
            else:
                self.cur.execute(
                    "SELECT p.id FROM posts p "  # noqa: S608
                    "LEFT JOIN post_vectors pv ON pv.post_id = p.id "
                    "WHERE pv.post_id IS NULL " + blacklist_clause
                    + " ORDER BY p.id",
                )
            return [r[0] for r in self.cur.fetchall()]

        return await asyncio.to_thread(_impl)
