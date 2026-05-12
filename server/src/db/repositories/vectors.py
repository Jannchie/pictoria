"""VectorRepo — async Repository over post_vectors (CLIP image embeddings).

All similarity searches go through DuckDB's HNSW index on
``post_vectors.embedding`` (cosine metric). The HNSW index activates
automatically once the index exists and the query uses
``array_cosine_distance(emb, CAST(? AS FLOAT[768]))`` in ORDER BY.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from db import SimilarImageResult
from db.helpers import fetch_all_dicts

if TYPE_CHECKING:
    import duckdb
    import numpy as np

EMBED_DIM = 768


class VectorRepo:
    def __init__(self, cur: duckdb.DuckDBPyConnection) -> None:
        self.cur = cur

    async def get(self, post_id: int) -> list[float] | None:
        def _impl() -> list[float] | None:
            self.cur.execute(
                "SELECT embedding FROM post_vectors WHERE post_id = ?",
                [post_id],
            )
            row = self.cur.fetchone()
            return list(row[0]) if row else None

        return await asyncio.to_thread(_impl)

    async def upsert(self, post_id: int, embedding: np.ndarray | list[float]) -> None:
        emb = embedding.tolist() if hasattr(embedding, "tolist") else list(embedding)

        def _impl() -> None:
            self.cur.execute(
                "INSERT INTO post_vectors(post_id, embedding) VALUES (?, ?) "
                "ON CONFLICT (post_id) DO UPDATE SET embedding = excluded.embedding",
                [post_id, emb],
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
        emb = embedding.tolist() if hasattr(embedding, "tolist") else list(embedding)
        fetch_limit = limit + (1 if skip_self else 0)

        def _impl() -> list[SimilarImageResult]:
            self.cur.execute(
                f"""
                SELECT post_id,
                       array_cosine_distance(embedding, CAST(? AS FLOAT[{EMBED_DIM}])) AS distance
                FROM post_vectors
                ORDER BY distance
                LIMIT ?
                """,  # noqa: S608
                [emb, fetch_limit],
            )
            rows = fetch_all_dicts(self.cur)
            if skip_self and rows:
                rows = rows[1:]
            return [SimilarImageResult(**r) for r in rows[:limit]]

        return await asyncio.to_thread(_impl)

    async def list_missing_post_ids(self) -> list[int]:
        """Return post ids that don't yet have an embedding."""

        def _impl() -> list[int]:
            self.cur.execute(
                "SELECT p.id FROM posts p "
                "LEFT JOIN post_vectors pv ON pv.post_id = p.id "
                "WHERE pv.post_id IS NULL "
                "ORDER BY p.id",
            )
            return [r[0] for r in self.cur.fetchall()]

        return await asyncio.to_thread(_impl)
