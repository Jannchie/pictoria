"""Tests for near-duplicate grouping (canonical_post_id).

Covers the read-side hiding of group members, the canonical-aware tag facet
count, the ON DELETE SET NULL promotion, and the SigLIP2-driven detection
(batch rebuild + incremental assignment). Embedding-based tests seed their own
deterministic unit-axis vectors so cosine distances are exactly 0 or 1.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pytest

from db.filters import PostFilter, PostFilterWithOrder
from db.repositories.vectors import VectorRepo
from services.dedup import assign_group_for_post, rebuild_groups

if TYPE_CHECKING:
    from db.connection import DB
    from db.queries.post_query import PostQueryService
    from db.repositories.posts import PostRepo


def _unit_vec(direction: int, dim: int = 1152) -> list[float]:
    v = np.zeros(dim, dtype=np.float32)
    v[direction] = 1.0
    return v.tolist()


@pytest.fixture
def vec_repo(db: DB) -> VectorRepo:
    return VectorRepo(db.cursor())


# ─── read-side: members are hidden, canonical carries the count ─────────────
class TestReadSideHiding:
    async def test_member_excluded_from_search_and_count(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([2], 1)  # post 2 becomes a member of post 1
        assert await query.count(PostFilter()) == 4
        rows = await query.search(PostFilterWithOrder())
        assert 2 not in {r["id"] for r in rows}
        items, _ = await query.list_paginated(0, 100)
        assert 2 not in {p["id"] for p in items}

    async def test_only_canonical_false_includes_members(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([2], 1)
        assert await query.count(PostFilter(only_canonical=False)) == 5

    async def test_canonical_reports_member_count(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([2, 3], 1)
        d = await query.get_detail(1)
        assert d is not None
        assert d["group_member_count"] == 2
        rows = await query.search(PostFilterWithOrder(order_by="id", order="asc"))
        by_id = {r["id"]: r for r in rows}
        assert by_id[1]["group_member_count"] == 2
        assert by_id[4]["group_member_count"] == 0

    async def test_get_group_members(self, post_repo: PostRepo, query: PostQueryService) -> None:
        await post_repo.set_canonical([2, 3], 1)
        members = await query.get_group_members(1)
        assert [m["id"] for m in members] == [2, 3]
        assert await query.get_group_members(4) == []


# ─── canonical-aware tag facet counts ───────────────────────────────────────
class TestTagCountWithGrouping:
    async def _artist_count(self, query: PostQueryService) -> int:
        rows = await query.count_by_tag(PostFilter())
        return {r["tag_name"]: r["count"] for r in rows}.get("artist_a", 0)

    async def test_grouping_decrements_and_ungrouping_restores(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        # seed: artist_a on posts 1 & 5 -> count 2
        assert await self._artist_count(query) == 2
        await post_repo.set_canonical([5], 1)  # post 5 hidden -> artist_a drops to 1
        assert await self._artist_count(query) == 1
        await post_repo.clear_canonical([5])  # back to visible
        assert await self._artist_count(query) == 2

    async def test_delete_member_does_not_undercount(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([5], 1)  # artist_a now 1 (post 1 only)
        await post_repo.delete_many([5])  # member delete must not touch the count
        assert await self._artist_count(query) == 1

    async def test_delete_canonical_promotes_members(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([5], 1)  # post 5 hidden under post 1
        await post_repo.delete_many([1])  # ON DELETE SET NULL promotes post 5
        post5 = await post_repo.get(5)
        assert post5 is not None
        assert post5.canonical_post_id is None
        # post 5 is visible again and carries artist_a back into the facet
        assert await self._artist_count(query) == 1  # only post 5 left with artist_a
        assert 5 in {r["id"] for r in await query.search(PostFilterWithOrder())}


# ─── SigLIP2 detection: batch rebuild + incremental ─────────────────────────
class TestDetection:
    async def _embed(self, vec_repo: VectorRepo) -> None:
        # posts 1 & 2 identical (cosine distance 0); 3/4/5 mutually orthogonal.
        await vec_repo.upsert(1, _unit_vec(0))
        await vec_repo.upsert(2, _unit_vec(0))
        await vec_repo.upsert(3, _unit_vec(5))
        await vec_repo.upsert(4, _unit_vec(10))
        await vec_repo.upsert(5, _unit_vec(20))

    async def test_rebuild_groups_identical_under_earliest(
        self, post_repo: PostRepo, vec_repo: VectorRepo, query: PostQueryService,
    ) -> None:
        await self._embed(vec_repo)
        assigned = await rebuild_groups(post_repo, vec_repo, threshold=0.1)
        assert assigned == 1  # only post 2 grouped
        post2 = await post_repo.get(2)
        assert post2 is not None
        assert post2.canonical_post_id == 1  # earliest id wins canonical
        post1 = await post_repo.get(1)
        assert post1 is not None and post1.canonical_post_id is None
        # post 2 hidden from listings
        assert 2 not in {r["id"] for r in await query.search(PostFilterWithOrder())}

    async def test_rebuild_is_idempotent(
        self, post_repo: PostRepo, vec_repo: VectorRepo,
    ) -> None:
        await self._embed(vec_repo)
        first = await rebuild_groups(post_repo, vec_repo, threshold=0.1)
        second = await rebuild_groups(post_repo, vec_repo, threshold=0.1)
        assert first == second == 1

    async def test_assign_group_for_new_post(
        self, post_repo: PostRepo, vec_repo: VectorRepo,
    ) -> None:
        await vec_repo.upsert(1, _unit_vec(0))
        await vec_repo.upsert(2, _unit_vec(0))  # identical to post 1, higher id
        canonical = await assign_group_for_post(post_repo, vec_repo, 2, threshold=0.1)
        assert canonical == 1
        post2 = await post_repo.get(2)
        assert post2 is not None and post2.canonical_post_id == 1

    async def test_assign_no_match_leaves_ungrouped(
        self, post_repo: PostRepo, vec_repo: VectorRepo,
    ) -> None:
        await vec_repo.upsert(1, _unit_vec(0))
        await vec_repo.upsert(2, _unit_vec(50))  # orthogonal to everything
        canonical = await assign_group_for_post(post_repo, vec_repo, 2, threshold=0.1)
        assert canonical is None
        post2 = await post_repo.get(2)
        assert post2 is not None and post2.canonical_post_id is None


# ─── score propagation to group members ─────────────────────────────────────
class TestScorePropagation:
    async def test_score_mirrors_to_all_members(
        self, post_repo: PostRepo,
    ) -> None:
        # seed scores: post 2 = 0 (unset), post 3 = 5 (already scored). Scoring
        # the canonical mirrors onto *both* — the group always shares its score.
        await post_repo.set_canonical([2, 3], 1)
        await post_repo.update_field(1, "score", 4)
        p1 = await post_repo.get(1)
        p2 = await post_repo.get(2)
        p3 = await post_repo.get(3)
        assert p1 is not None and p1.score == 4
        assert p2 is not None and p2.score == 4  # was unset -> mirrors
        assert p3 is not None and p3.score == 4  # had its own score -> overwritten

    async def test_score_zero_clears_group(
        self, post_repo: PostRepo,
    ) -> None:
        # post 3 (seed score 5) under canonical 1; clearing the canonical to 0
        # mirrors the 0 onto the member too (full mirror, not just positive).
        await post_repo.set_canonical([3], 1)
        await post_repo.update_field(1, "score", 0)
        p1 = await post_repo.get(1)
        p3 = await post_repo.get(3)
        assert p1 is not None and p1.score == 0
        assert p3 is not None and p3.score == 0

    async def test_bulk_score_propagates_per_canonical(
        self, post_repo: PostRepo,
    ) -> None:
        # post 2 (unset) + post 3 (seed 5) under canonical 1; post 4 (unset)
        # under canonical 5. Bulk-scoring both canonicals mirrors to every member.
        await post_repo.set_canonical([2, 3], 1)
        await post_repo.set_canonical([4], 5)
        await post_repo.bulk_update_field([1, 5], "score", 2)
        p2 = await post_repo.get(2)
        p3 = await post_repo.get(3)
        p4 = await post_repo.get(4)
        assert p2 is not None and p2.score == 2  # was unset -> mirrors
        assert p3 is not None and p3.score == 2  # already scored -> overwritten
        assert p4 is not None and p4.score == 2

    async def test_non_score_field_does_not_propagate(
        self, post_repo: PostRepo,
    ) -> None:
        await post_repo.set_canonical([2], 1)
        await post_repo.update_field(1, "rating", 4)
        p2 = await post_repo.get(2)
        assert p2 is not None and p2.rating == 0  # rating is not cascaded


# ─── similar search hides members ───────────────────────────────────────────
class TestSimilarExcludesMembers:
    async def test_only_canonical_drops_members(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([2], 1)
        rows = await query.list_simple_by_ids_preserving_order([1, 2, 3], only_canonical=True)
        assert [r["id"] for r in rows] == [1, 3]
        # default keeps everything (other callers rely on order preservation)
        rows_all = await query.list_simple_by_ids_preserving_order([1, 2, 3])
        assert [r["id"] for r in rows_all] == [1, 2, 3]


# ─── manual group editing ───────────────────────────────────────────────────
class TestManualEditing:
    async def test_make_canonical_repoints_group(
        self, post_repo: PostRepo, query: PostQueryService,
    ) -> None:
        await post_repo.set_canonical([2, 3], 1)  # group: canonical 1, members 2,3
        await post_repo.make_canonical(2)  # promote post 2
        post1 = await post_repo.get(1)
        post2 = await post_repo.get(2)
        post3 = await post_repo.get(3)
        assert post2 is not None and post2.canonical_post_id is None  # new canonical
        assert post1 is not None and post1.canonical_post_id == 2  # old canonical demoted
        assert post3 is not None and post3.canonical_post_id == 2  # sibling re-pointed
        # post 2 now represents the group in listings; 1 and 3 are hidden
        visible = {r["id"] for r in await query.search(PostFilterWithOrder())}
        assert 2 in visible
        assert 1 not in visible and 3 not in visible
