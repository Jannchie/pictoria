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
from db.helpers import sql_placeholders, transaction
from db.repositories.failures import not_failed_clause

if TYPE_CHECKING:
    import sqlite3

    import numpy as np


# Canonical SigLIP 2 table name + dimensionality. Import these instead of
# re-declaring the literals elsewhere.
SIGLIP2_TABLE = "post_vectors_siglip2"
SIGLIP2_DIM = 1152

# Table names may only come from this code-level allowlist: they are
# interpolated into SQL strings (a placeholder can't stand in for an
# identifier), so the set is sealed to keep any external input out of the
# table name. The value is the vec0 table's dimensionality.
_ALLOWED_TABLES: dict[str, int] = {
    SIGLIP2_TABLE: SIGLIP2_DIM,
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
        table: str = SIGLIP2_TABLE,
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

    async def upsert_many(self, pairs: list[tuple[int, list[float]]]) -> None:
        """Insert or replace many ``(post_id, embedding)`` pairs in one batch.

        Batch counterpart of :meth:`upsert` — same DELETE + INSERT emulation
        (vec0 doesn't support ON CONFLICT), one ``executemany`` per statement.
        Wrapped in an explicit transaction: connections are autocommit, so
        without it an interruption mid-batch would commit half the rows (or
        a DELETE without its INSERT).
        """
        if not pairs:
            return
        blobs: list[tuple[int, bytes]] = []
        for post_id, emb in pairs:
            if len(emb) != self.dim:
                msg = f"{self.table}: expected dim {self.dim}, got {len(emb)}"
                raise ValueError(msg)
            blobs.append((post_id, sqlite_vec.serialize_float32(emb)))

        def _impl() -> None:
            with transaction(self.cur):
                self.cur.executemany(
                    f"DELETE FROM {self.table} WHERE post_id = ?",  # noqa: S608
                    [(pid,) for pid, _ in blobs],
                )
                self.cur.executemany(
                    f"INSERT INTO {self.table}(post_id, embedding) VALUES (?, ?)",  # noqa: S608
                    blobs,
                )

        await asyncio.to_thread(_impl)

    # ─── Sync cores (callable from inside another asyncio.to_thread block) ──
    def exists_sync(self, post_id: int) -> bool:
        """Whether ``post_id`` has an embedding — a single vec0 point lookup."""
        self.cur.execute(
            f"SELECT 1 FROM {self.table} WHERE post_id = ?",  # noqa: S608
            [post_id],
        )
        return self.cur.fetchone() is not None

    def knn_sync(self, seed_post_id: int, k: int) -> list[tuple[int, float]]:
        """Raw KNN rows ``(post_id, distance)`` around ``seed_post_id``, nearest first.

        The seed row itself comes back too (distance ~= 0) — callers that
        don't want it filter it out. Returns ``[]`` when the seed has no
        embedding: vec0's MATCH rejects NULL as the query vector with a hard
        OperationalError, so short-circuit instead of letting the inner
        subselect bubble up a confusing schema-level error.
        """
        if not self.exists_sync(seed_post_id):
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
            [seed_post_id, k],
        )
        return [(int(pid), float(dist)) for pid, dist in self.cur.fetchall()]

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
        a subselect (see :meth:`knn_sync`). Returns ``[]`` when the source
        has no embedding.
        """
        fetch_limit = limit + 1

        def _impl() -> list[SimilarImageResult]:
            rows = self.knn_sync(post_id, fetch_limit)
            # The source row itself comes back first (distance ~= 0); drop it.
            filtered = [(pid, dist) for pid, dist in rows if pid != post_id]
            return [
                SimilarImageResult(post_id=pid, distance=dist)
                for pid, dist in filtered[:limit]
            ]

        return await asyncio.to_thread(_impl)

    async def load_all(self) -> tuple[list[int], np.ndarray]:
        """Load every embedding into a ``(N, dim)`` float32 matrix + id list.

        Returned ids are ascending and parallel to the matrix rows. Drives the
        GPU near-duplicate batch, which needs all vectors in memory at once: a
        per-post KNN over a large library is ~1s each (infeasible at 170k), so
        the batch instead does one chunked matrix-multiply over this matrix. The
        ascending id order makes the greedy "earliest post is canonical"
        assignment deterministic.
        """
        import numpy as np  # noqa: PLC0415

        def _impl() -> tuple[list[int], np.ndarray]:
            self.cur.execute(
                f"SELECT post_id, embedding FROM {self.table} ORDER BY post_id ASC",  # noqa: S608
            )
            ids: list[int] = []
            vecs: list[np.ndarray] = []
            for pid, blob in self.cur.fetchall():
                ids.append(pid)
                vecs.append(np.frombuffer(bytes(blob), dtype=np.float32))
            if not vecs:
                return [], np.empty((0, self.dim), dtype=np.float32)
            return ids, np.vstack(vecs)

        return await asyncio.to_thread(_impl)

    def embedded_post_ids_sync(self) -> set[int]:
        """Every post_id present in ``self.table``, as a set.

        A plain scan of the vec0 rowid column (no distance computation), so
        it stays fast at library scale — used to turn per-row vec0 probes
        into one set-difference (see ``list_missing_post_ids``).
        """
        self.cur.execute(f"SELECT post_id FROM {self.table}")  # noqa: S608
        return {row[0] for row in self.cur.fetchall()}

    async def list_embedded_post_ids(self) -> set[int]:
        """Async wrapper over :meth:`embedded_post_ids_sync`."""
        return await asyncio.to_thread(self.embedded_post_ids_sync)

    async def list_missing_post_ids(
        self,
        *,
        image_exts: list[str] | None = None,
        worker: str,
    ) -> list[int]:
        """Return post ids that don't yet have an embedding in ``self.table``.

        ``image_exts`` (without leading dot, e.g. ``['jpg','png',...]``)
        narrows the pending set to image rows — non-image posts would just
        be filtered out one-by-one in the worker, but would still inflate
        the progress total. Passing the list lets the DB do that filter.

        ``worker`` selects which ``post_process_failures`` bucket to honour
        as a one-shot blacklist; the SigLIP 2 worker passes
        ``WORKER_EMBEDDING_SIGLIP2`` so each table has its own failure log.
        """

        def _impl() -> list[int]:
            # Candidates come from plain-table predicates only; the "already
            # embedded?" check is a Python set-difference rather than a
            # LEFT JOIN ... IS NULL: a vec0 lookup is a virtual-table probe,
            # not a B-tree probe, so the join ran one probe per posts row
            # (tens of seconds at 170k posts), whereas scanning the vec0
            # post_id column once is fast.
            clauses: list[str] = []
            params: list[object] = []
            if image_exts:
                # The `?` placeholder count is derived from len(image_exts);
                # ext strings flow through cur.execute params, never into SQL.
                placeholders = sql_placeholders(image_exts)
                clauses.append(f"LOWER(p.extension) IN ({placeholders})")
                params.extend(image_exts)
            clauses.append(not_failed_clause("p"))
            params.append(worker)
            self.cur.execute(
                f"SELECT p.id FROM posts p WHERE {' AND '.join(clauses)} ORDER BY p.id",  # noqa: S608
                params,
            )
            candidates = [r[0] for r in self.cur.fetchall()]
            embedded = self.embedded_post_ids_sync()
            # Candidates are already ordered by p.id; the subtraction keeps it.
            return [pid for pid in candidates if pid not in embedded]

        return await asyncio.to_thread(_impl)
