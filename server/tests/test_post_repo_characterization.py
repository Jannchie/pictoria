"""Characterization (golden-master) tests for the posts data-access layer.

These pin the *current* observable behaviour against the deterministic fixture
in ``conftest.py``. They must stay green verbatim through the repository
split/redesign — that is the whole point: they prove the refactor preserves
behaviour. Expected values are computed by hand from the seed data, not
captured from a run, so they document intent.

Post-refactor the surface is split across:
- ``PostQueryService`` (``query`` fixture): detail/list/search + counts/aggregates
- ``TagRepo`` (``tag_repo``): post↔tag association
- ``ScoreRepo`` (``score_repo``): waifu / aesthetic scores
- ``PostRepo`` (``post_repo``): core posts-table CRUD
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from db.filters import PostFilter, PostFilterWithOrder

if TYPE_CHECKING:
    from db.queries.post_query import PostQueryService
    from db.repositories.posts import PostRepo
    from db.repositories.scores import ScoreRepo
    from db.repositories.tags import TagRepo


def _tag_summary(detail: dict) -> list[tuple[str, bool, str | None]]:
    """(name, is_auto, group_name) for each tag, in returned order."""
    return [
        (
            t["tag_info"]["name"],
            t["is_auto"],
            (t["tag_info"]["group"] or {}).get("name"),
        )
        for t in detail["tags"]
    ]


# ─── get_detail ───────────────────────────────────────────────────────────
class TestGetDetail:
    async def test_full_assembly(self, query: PostQueryService) -> None:
        d = await query.get_detail(1)
        assert d is not None
        assert d["id"] == 1
        assert d["full_path"] == "photos/a.jpg"
        assert d["aspect_ratio"] == pytest.approx(101 / 200)
        assert d["dominant_color"] == pytest.approx([50.0, 10.0, -5.0])
        assert d["colors"] == [
            {"order": 0, "color": 16711680},
            {"order": 1, "color": 65280},
        ]
        assert d["waifu_score"] == {"score": 8.5}
        assert d["aesthetic_scores"] == [{"scorer": "siglip-v2-5", "score": 4.25}]

    async def test_tag_ordering_by_canonical_group(self, query: PostQueryService) -> None:
        # artist group (rank 0) sorts before general group (rank 3).
        d = await query.get_detail(1)
        assert d is not None
        assert _tag_summary(d) == [
            ("artist_a", True, "artist"),
            ("tag_general", False, "general"),
        ]

    async def test_post_without_joins(self, query: PostQueryService) -> None:
        d = await query.get_detail(2)
        assert d is not None
        assert d["dominant_color"] is None
        assert d["colors"] == []
        assert d["waifu_score"] is None
        assert d["aesthetic_scores"] == []
        assert _tag_summary(d) == [("no_group_tag", False, None)]

    async def test_missing_post_returns_none(self, query: PostQueryService) -> None:
        assert await query.get_detail(999) is None


# ─── list_paginated ─────────────────────────────────────────────────────────
class TestListPaginated:
    async def test_full_page_no_cursor(self, query: PostQueryService) -> None:
        items, cursor = await query.list_paginated(0, 100)
        assert [p["id"] for p in items] == [1, 2, 3, 4, 5]
        assert cursor is None
        # assembled keys present on every item
        assert all({"tags", "colors", "waifu_score", "aesthetic_scores"} <= p.keys() for p in items)

    async def test_pagination_cursor(self, query: PostQueryService) -> None:
        items, cursor = await query.list_paginated(0, 2)
        assert [p["id"] for p in items] == [1, 2]
        assert cursor == 3

    async def test_batched_assembly_matches_detail(self, query: PostQueryService) -> None:
        items, _ = await query.list_paginated(0, 100)
        by_id = {p["id"]: p for p in items}
        assert by_id[1]["waifu_score"] == {"score": 8.5}
        assert by_id[2]["waifu_score"] is None
        assert by_id[1]["aesthetic_scores"] == [{"scorer": "siglip-v2-5", "score": 4.25}]
        assert by_id[3]["colors"] == [{"order": 0, "color": 255}]

    async def test_tag_order_matches_get_detail(self, query: PostQueryService) -> None:
        # Regression: list_paginated used to sort tags by name only; it now
        # sorts by canonical group rank (artist→copyright→character→general
        # →meta→other) like get_detail. Post #1 has artist_a (artist) and
        # tag_general (general) — artist must come first in both code paths.
        items, _ = await query.list_paginated(0, 100)
        by_id = {p["id"]: p for p in items}
        list_tag_names = [t["tag_info"]["name"] for t in by_id[1]["tags"]]
        detail = await query.get_detail(1)
        assert detail is not None
        detail_tag_names = [t["tag_info"]["name"] for t in detail["tags"]]
        assert list_tag_names == detail_tag_names == ["artist_a", "tag_general"]


# ─── count / aggregates ─────────────────────────────────────────────────────
class TestCounts:
    async def test_count_no_filter(self, query: PostQueryService) -> None:
        assert await query.count(PostFilter()) == 5

    @pytest.mark.parametrize(
        ("filters", "expected"),
        [
            ({"rating": (2,)}, 2),
            ({"score": (3,)}, 2),
            ({"extension": ("jpg",)}, 3),
            ({"tags": ("tag_general",)}, 2),
            ({"folder": "photos"}, 3),
            ({"folder": "."}, 5),
            ({"waifu_score_levels": ("S",)}, 1),
            ({"waifu_score_levels": ("UNSCORED",)}, 1),
            ({"waifu_score_range": (4.0, 9.0)}, 2),
        ],
    )
    async def test_count_filtered(self, query: PostQueryService, filters: dict, expected: int) -> None:
        assert await query.count(PostFilter(**filters)) == expected

    async def test_count_by_column_rating(self, query: PostQueryService) -> None:
        rows = await query.count_by_column("rating", PostFilter())
        assert sorted((r["rating"], r["count"]) for r in rows) == [(0, 1), (1, 1), (2, 2), (3, 1)]

    async def test_count_by_column_extension(self, query: PostQueryService) -> None:
        rows = await query.count_by_column("extension", PostFilter())
        assert sorted((r["extension"], r["count"]) for r in rows) == [("jpg", 3), ("png", 1), ("webp", 1)]

    async def test_count_by_column_rejects_unsafe(self, query: PostQueryService) -> None:
        with pytest.raises(ValueError, match="unsafe column"):
            await query.count_by_column("file_path; DROP TABLE posts", PostFilter())

    async def test_count_by_waifu_bucket(self, query: PostQueryService) -> None:
        rows = await query.count_by_waifu_bucket(PostFilter())
        assert {r["bucket"]: r["count"] for r in rows} == {"S": 1, "B": 1, "C": 1, "D": 1, "UNSCORED": 1}

    async def test_aggregate_stats(self, query: PostQueryService) -> None:
        s = await query.aggregate_stats(PostFilter())
        assert s["total"] == 5
        assert s["scored_count"] == 3
        assert s["avg_score"] == pytest.approx(11 / 3)
        assert s["waifu_count"] == 4
        assert s["avg_waifu_score"] == pytest.approx(4.5)
        assert sorted((r["rating"], r["count"]) for r in s["rating_distribution"]) == [
            (0, 1), (1, 1), (2, 2), (3, 1),
        ]


# ─── search ─────────────────────────────────────────────────────────────────
class TestSearch:
    async def test_no_filter_returns_all(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder())
        assert sorted(r["id"] for r in rows) == [1, 2, 3, 4, 5]
        assert all("colors" in r for r in rows)

    async def test_extension_filter(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(extension=("png",)))
        assert [r["id"] for r in rows] == [2]

    async def test_tags_filter(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(tags=("artist_a",)))
        assert sorted(r["id"] for r in rows) == [1, 5]

    async def test_waifu_levels_filter(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(waifu_score_levels=("S", "UNSCORED")))
        assert sorted(r["id"] for r in rows) == [1, 2]

    async def test_order_by_id_asc(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(order_by="id", order="asc"))
        assert [r["id"] for r in rows] == [1, 2, 3, 4, 5]

    async def test_order_by_waifu_score_nulls_last(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(order_by="waifu_score", order="desc"))
        assert [r["id"] for r in rows] == [1, 3, 5, 4, 2]

    async def test_order_by_siglip_score_nulls_last(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(order_by="siglip_score", order="desc"))
        assert [r["id"] for r in rows][:2] == [3, 1]

    async def test_lab_distance_ordering(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(lab=(50.0, 10.0, -5.0)))
        # only posts with a dominant_color participate; exact match sorts first
        assert {r["id"] for r in rows} == {1, 3, 5}
        assert rows[0]["id"] == 1
        assert all("_dist" not in r for r in rows)

    async def test_colors_attached(self, query: PostQueryService) -> None:
        rows = await query.search(PostFilterWithOrder(order_by="id", order="asc"))
        by_id = {r["id"]: r for r in rows}
        assert by_id[1]["colors"] == [{"order": 0, "color": 16711680}, {"order": 1, "color": 65280}]
        assert by_id[2]["colors"] == []


# ─── tag association (preserves the user's collapsed add_tag) ───────────────
class TestTagAssociation:
    async def test_add_new_tag_returns_true(self, tag_repo: TagRepo, query: PostQueryService) -> None:
        assert await tag_repo.add_tag(3, "fresh_tag") is True
        d = await query.get_detail(3)
        assert d is not None
        assert "fresh_tag" in {t["tag_info"]["name"] for t in d["tags"]}

    async def test_add_existing_tag_returns_false(self, tag_repo: TagRepo) -> None:
        assert await tag_repo.add_tag(1, "artist_a") is False

    async def test_add_then_re_add_is_idempotent(self, tag_repo: TagRepo) -> None:
        assert await tag_repo.add_tag(2, "twice") is True
        assert await tag_repo.add_tag(2, "twice") is False

    async def test_remove_tag(self, tag_repo: TagRepo) -> None:
        assert await tag_repo.remove_tag(1, "artist_a") is True
        assert await tag_repo.remove_tag(1, "artist_a") is False

    async def test_set_tags_bulk_creates_new(self, tag_repo: TagRepo, query: PostQueryService) -> None:
        # Empty input is a no-op (avoid driver-specific executemany([]) quirks).
        await tag_repo.set_tags_bulk(2, [], is_auto=True)

        await tag_repo.set_tags_bulk(2, ["bulk_a", "bulk_b", "bulk_c"], is_auto=True)
        d = await query.get_detail(2)
        assert d is not None
        names_with_flag = {(t["tag_info"]["name"], t["is_auto"]) for t in d["tags"]}
        assert ("bulk_a", True) in names_with_flag
        assert ("bulk_b", True) in names_with_flag
        assert ("bulk_c", True) in names_with_flag

    async def test_set_tags_bulk_idempotent_on_conflict(self, tag_repo: TagRepo, query: PostQueryService) -> None:
        # Re-applying the same bulk set should not raise and should not flip
        # the is_auto flag on rows that already exist as manual tags.
        await tag_repo.set_tags_bulk(1, ["artist_a", "tag_general"], is_auto=True)
        d = await query.get_detail(1)
        assert d is not None
        flags = {t["tag_info"]["name"]: t["is_auto"] for t in d["tags"]}
        # artist_a was already auto=1; tag_general was already auto=0; both stay.
        assert flags == {"artist_a": True, "tag_general": False}


# ─── scores ──────────────────────────────────────────────────────────────────
class TestScores:
    async def test_get_waifu_score(self, score_repo: ScoreRepo) -> None:
        assert await score_repo.get_waifu_score(1) == 8.5
        assert await score_repo.get_waifu_score(2) is None

    async def test_upsert_waifu_score(self, score_repo: ScoreRepo) -> None:
        await score_repo.upsert_waifu_score(2, 7.0)
        assert await score_repo.get_waifu_score(2) == 7.0
        await score_repo.upsert_waifu_score(1, 9.9)  # update existing
        assert await score_repo.get_waifu_score(1) == 9.9

    async def test_get_aesthetic_score(self, score_repo: ScoreRepo) -> None:
        assert await score_repo.get_aesthetic_score(1, "siglip-v2-5") == 4.25
        assert await score_repo.get_aesthetic_score(2, "siglip-v2-5") is None

    async def test_get_aesthetic_scores_list(self, score_repo: ScoreRepo) -> None:
        assert await score_repo.get_aesthetic_scores(3) == [{"scorer": "siglip-v2-5", "score": 6.5}]

    async def test_upsert_aesthetic_score(self, score_repo: ScoreRepo) -> None:
        await score_repo.upsert_aesthetic_score(2, "siglip-v2-5", 5.0)
        assert await score_repo.get_aesthetic_score(2, "siglip-v2-5") == 5.0

    async def test_waifu_score_distribution(self, score_repo: ScoreRepo) -> None:
        # Seed scores: 8.5 (bucket 8), 5.0 (bucket 5), 1.0 (bucket 1), 3.5 (bucket 3).
        # All 10 integer buckets must be present; un-hit ones zero-filled.
        dist = await score_repo.waifu_score_distribution()
        as_dict = dict(dist)
        assert sorted(as_dict.keys()) == list(range(10))
        assert as_dict[1] == 1
        assert as_dict[3] == 1
        assert as_dict[5] == 1
        assert as_dict[8] == 1
        # Buckets without seed data must surface as zero, not be absent.
        assert as_dict[0] == 0
        assert as_dict[9] == 0
        assert sum(as_dict.values()) == 4  # total scored posts

    async def test_waifu_score_distribution_clamps_ten_to_bucket_nine(
        self, score_repo: ScoreRepo,
    ) -> None:
        # The chart treats the score-domain as [0, 10] inclusive; without the
        # ``score >= 9 THEN 9`` clamp, a perfect 10.0 would land in a phantom
        # 10th bucket and silently disappear from the histogram.
        await score_repo.upsert_waifu_score(2, 10.0)
        dist = dict(await score_repo.waifu_score_distribution())
        # 9 covers both seed 8.5? No — 8.5 lives in bucket 8. The new 10.0
        # is the only one in bucket 9.
        assert dist[9] == 1


# ─── core mutations & cascade ───────────────────────────────────────────────
class TestCoreMutations:
    async def test_update_field(self, post_repo: PostRepo, query: PostQueryService) -> None:
        assert await post_repo.update_field(1, "score", 9) is True
        d = await query.get_detail(1)
        assert d is not None
        assert d["score"] == 9

    async def test_update_field_missing_post(self, post_repo: PostRepo) -> None:
        assert await post_repo.update_field(999, "score", 9) is False

    async def test_update_field_rejects_unwhitelisted(self, post_repo: PostRepo) -> None:
        with pytest.raises(ValueError, match="not whitelisted"):
            await post_repo.update_field(1, "file_path", "x")

    async def test_delete_many_removes_and_counts(self, post_repo: PostRepo, query: PostQueryService) -> None:
        await post_repo.delete_many([2])
        assert await query.count(PostFilter()) == 4
        assert await query.get_detail(2) is None
