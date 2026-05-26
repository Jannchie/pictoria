"""Tests for text-vector search combined with post filters.

``PostQueryService.search_by_text_vector`` pre-filters with ``build_where`` and
then ranks the surviving candidates by SigLIP 2 cosine similarity. These seed
the conftest posts (1-5) with deterministic embeddings on 1/3/5 (2/4 stay
unembedded) so both the ranking and the pre-filter are observable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from db.filters import PostFilter
from db.repositories.vectors import VectorRepo

if TYPE_CHECKING:
    from db.connection import DB
    from db.queries.post_query import PostQueryService


def _unit_vec(direction: int, dim: int = 1152) -> list[float]:
    v = np.zeros(dim, dtype=np.float32)
    v[direction] = 1.0
    return v.tolist()


async def _seed_vectors(db: DB) -> None:
    vectors = VectorRepo(db.cursor())
    await vectors.upsert(1, _unit_vec(0))    # identical to the query vector
    await vectors.upsert(3, _unit_vec(1))    # orthogonal (far)
    await vectors.upsert(5, _unit_vec(100))  # orthogonal (far)
    # posts 2 and 4 are intentionally left without an embedding.


async def test_ranks_by_similarity_and_excludes_unembedded(
    db: DB, query: PostQueryService,
) -> None:
    await _seed_vectors(db)
    rows = await query.search_by_text_vector(_unit_vec(0), PostFilter(), limit=10)
    ids = [r["id"] for r in rows]
    # post 1 (identical) ranks first; 2 and 4 have no embedding -> excluded by JOIN.
    assert ids[0] == 1
    assert set(ids) == {1, 3, 5}


async def test_folder_filter_prefilters(db: DB, query: PostQueryService) -> None:
    await _seed_vectors(db)
    # folder="art" covers conftest posts 4 and 5; only 5 has an embedding.
    rows = await query.search_by_text_vector(
        _unit_vec(0), PostFilter(folder="art"), limit=10,
    )
    ids = [r["id"] for r in rows]
    # Posts 1/3 are closer in vector space but live in "photos", so the
    # pre-filter excludes them; only the embedded "art" post (5) remains.
    assert ids == [5]


async def test_rating_filter_prefilters(db: DB, query: PostQueryService) -> None:
    await _seed_vectors(db)
    # rating=2 covers conftest posts 1 and 5, both embedded.
    rows = await query.search_by_text_vector(
        _unit_vec(0), PostFilter(rating=(2,)), limit=10,
    )
    ids = [r["id"] for r in rows]
    # Both pass the filter; post 1 (identical) ranks before post 5 (orthogonal).
    assert ids == [1, 5]
