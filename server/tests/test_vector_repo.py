"""Tests for VectorRepo — embedding upsert / similarity / similar_to_post.

These don't reuse the shared seed (which doesn't populate post_vectors_siglip2);
each test seeds its own deterministic embeddings so distance ordering is
predictable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pytest
import sqlite_vec

from db.repositories.posts import PostRepo
from db.repositories.vectors import VectorRepo

if TYPE_CHECKING:
    from db.connection import DB


def _unit_vec(direction: int, dim: int = 1152) -> list[float]:
    """Return a unit vector pointing along axis ``direction``.

    Lets us craft embeddings whose cosine distances are 0, 1, or 1-ish for
    deterministic ordering without depending on numerical noise.
    """
    v = np.zeros(dim, dtype=np.float32)
    v[direction] = 1.0
    return v.tolist()


@pytest.fixture
def vec_repo(db: DB) -> VectorRepo:
    # VectorRepo defaults to post_vectors_siglip2 (1152d), the sole vec table.
    return VectorRepo(db.cursor())


class TestUpsertAndGet:
    async def test_upsert_and_get_roundtrip(self, vec_repo: VectorRepo) -> None:
        vec = _unit_vec(0)
        await vec_repo.upsert(1, vec)
        got = await vec_repo.get(1)
        assert got is not None
        assert got[0] == pytest.approx(1.0)
        assert got[1] == pytest.approx(0.0)

    async def test_upsert_overwrites(self, vec_repo: VectorRepo) -> None:
        await vec_repo.upsert(1, _unit_vec(0))
        await vec_repo.upsert(1, _unit_vec(5))
        got = await vec_repo.get(1)
        assert got is not None
        assert got[0] == pytest.approx(0.0)
        assert got[5] == pytest.approx(1.0)

    async def test_get_missing_returns_none(self, vec_repo: VectorRepo) -> None:
        assert await vec_repo.get(999) is None


class TestSimilarToPost:
    async def test_similar_to_post_skips_source(self, vec_repo: VectorRepo) -> None:
        # similar_to_post should never return the source id back.
        await vec_repo.upsert(1, _unit_vec(0))
        await vec_repo.upsert(2, _unit_vec(0))  # identical to source
        await vec_repo.upsert(3, _unit_vec(50))  # different

        sims = await vec_repo.similar_to_post(1, limit=5)
        ids = [s.post_id for s in sims]
        assert 1 not in ids
        # The identical-to-source row should rank first.
        assert ids[0] == 2

    async def test_similar_to_post_missing_returns_empty(self, vec_repo: VectorRepo) -> None:
        sims = await vec_repo.similar_to_post(9999, limit=10)
        assert sims == []


class TestSiglip2Table:
    async def test_table_exists(self, db: DB) -> None:
        cur = db.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE name = 'post_vectors_siglip2'",
        )
        assert cur.fetchone() is not None

    async def test_rejects_wrong_dim_blob(self, db: DB) -> None:
        # vec0 enforces the declared dimension; a 768-float blob must fail.
        cur = db.cursor()
        blob = sqlite_vec.serialize_float32([0.0] * 768)
        with pytest.raises(Exception):  # noqa: B017, PT011  # sqlite rejects wrong dim
            cur.execute(
                "INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (1, ?)",
                [blob],
            )


class TestParameterizedTable:
    async def test_upsert_rejects_wrong_dim(self, vec_repo: VectorRepo) -> None:
        with pytest.raises(ValueError, match="expected dim 1152"):
            await vec_repo.upsert(1, _unit_vec(0, dim=768))

    async def test_rejects_unknown_table(self, db: DB) -> None:
        with pytest.raises(ValueError, match="unknown vector table"):
            VectorRepo(db.cursor(), table="post_vectors_evil")


class TestDeleteClearsVectorTable:
    async def test_delete_post_clears_vector_table(self, db: DB) -> None:
        vectors = VectorRepo(db.cursor())
        await vectors.upsert(1, _unit_vec(0))

        await PostRepo(db.cursor()).delete_many([1])

        assert await vectors.get(1) is None
