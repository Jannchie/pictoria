"""Folder aggregate stats: the GROUP BY query and the pure recursive roll-up.

The roll-up is the bug-prone part (recursive, weighted averages, empty
dirs), so it is tested as a pure function on hand-built trees with no
filesystem / DB. The query is characterized against the seeded temp DB.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

import shared
from db.queries.post_query import FolderScoreAgg, PostQueryService
from server.dependencies import REQUEST_DEPENDENCIES
from server.folders import DirectorySummary, FoldersController, attach_folder_stats

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from db.connection import DB


def _node(name: str, path: str, file_count: int = 0, children: list[DirectorySummary] | None = None) -> DirectorySummary:
    return DirectorySummary(name=name, path=path, file_count=file_count, children=children or [])


class TestAttachFolderStats:
    def _tree(self) -> DirectorySummary:
        # .
        # ├─ art            (direct posts 4,5)
        # ├─ photos         (direct posts 1,2)
        # │   └─ photos/sub (direct post 3)
        # └─ empty          (no posts at all)
        return _node("", ".", children=[
            _node("art", "art", file_count=2),
            _node("photos", "photos", file_count=2, children=[
                _node("sub", "photos/sub", file_count=1),
            ]),
            _node("empty", "empty"),
        ])

    def _aggregates(self) -> dict[str, FolderScoreAgg]:
        return {
            "art": FolderScoreAgg(posts=2, scored=1, score_total=3, rating_total=5, silva_total=1.3, silva_n=2),
            "photos": FolderScoreAgg(posts=2, scored=1, score_total=3, rating_total=2, silva_total=0.0, silva_n=0),
            "photos/sub": FolderScoreAgg(posts=1, scored=1, score_total=5, rating_total=1, silva_total=0.0, silva_n=0),
        }

    def test_leaf_direct_stats(self) -> None:
        tree = self._tree()
        attach_folder_stats(tree, self._aggregates())
        sub = tree.children[1].children[0]
        assert sub.post_count == 1
        assert sub.score_avg == pytest.approx(5.0)
        assert sub.rating_avg == pytest.approx(1.0)
        assert sub.scored_ratio == pytest.approx(1.0)
        assert sub.silva_avg is None  # no silva on this subtree

    def test_parent_rolls_up_descendants(self) -> None:
        tree = self._tree()
        attach_folder_stats(tree, self._aggregates())
        photos = tree.children[1]
        # photos direct (posts 1,2) + photos/sub (post 3)
        assert photos.post_count == 3
        assert photos.score_avg == pytest.approx(8 / 2)  # scored totals 3+5 over 2 scored
        assert photos.rating_avg == pytest.approx(3 / 3)  # rating totals 2+1 over 3 posts
        assert photos.scored_ratio == pytest.approx(2 / 3)
        assert photos.silva_avg is None

    def test_silva_is_raw_mean(self) -> None:
        tree = self._tree()
        attach_folder_stats(tree, self._aggregates())
        art = tree.children[0]
        assert art.silva_avg == pytest.approx(1.3 / 2)  # raw 0~1, frontend ×10

    def test_root_aggregates_whole_tree(self) -> None:
        tree = self._tree()
        total = attach_folder_stats(tree, self._aggregates())
        assert tree.post_count == 5
        assert tree.score_avg == pytest.approx(11 / 3)  # (3+3+5) over 3 scored
        assert tree.rating_avg == pytest.approx(8 / 5)  # (5+2+1) over 5 posts
        assert tree.scored_ratio == pytest.approx(3 / 5)
        assert tree.silva_avg == pytest.approx(1.3 / 2)
        # return value mirrors the root's rolled-up sums
        assert total.posts == 5
        assert total.silva_n == 2

    def test_empty_dir_has_no_stats(self) -> None:
        tree = self._tree()
        attach_folder_stats(tree, self._aggregates())
        empty = tree.children[2]
        assert empty.post_count == 0
        assert empty.silva_avg is None
        assert empty.score_avg is None
        assert empty.rating_avg is None
        assert empty.scored_ratio is None


class TestFolderScoreAggregates:
    async def test_group_by_file_path(self, query: PostQueryService) -> None:
        agg = await query.folder_score_aggregates()

        # photos: posts 1 (rating2 score3) + 2 (rating0 score0, unscored), no silva
        assert agg["photos"].posts == 2
        assert agg["photos"].scored == 1
        assert agg["photos"].score_total == 3
        assert agg["photos"].rating_total == 2
        assert agg["photos"].silva_n == 0
        assert agg["photos"].silva_total == pytest.approx(0.0)

        # photos/sub: post 3 (rating1 score5), no silva
        assert agg["photos/sub"].posts == 1
        assert agg["photos/sub"].scored == 1
        assert agg["photos/sub"].score_total == 5
        assert agg["photos/sub"].rating_total == 1

        # art: post 4 (rating3 score0 silva0.4) + 5 (rating2 score3 silva0.9)
        assert agg["art"].posts == 2
        assert agg["art"].scored == 1
        assert agg["art"].score_total == 3
        assert agg["art"].rating_total == 5
        assert agg["art"].silva_n == 2
        assert agg["art"].silva_total == pytest.approx(1.3)


def _find(node: dict, path: str) -> dict | None:
    if node["path"] == path:
        return node
    for child in node["children"]:
        hit = _find(child, path)
        if hit is not None:
            return hit
    return None


class TestFoldersEndpoint:
    """End-to-end: DI injection of post_query + filesystem walk + stats attach + serialization."""

    @pytest.fixture
    def folders_client(self, db: DB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        images_dir = tmp_path / "images"
        # Mirror the seeded file_paths on disk so the filesystem walk produces
        # matching tree nodes for the DB aggregates to attach to.
        for rel in ("art", "photos/sub"):
            (images_dir / rel).mkdir(parents=True, exist_ok=True)
        (images_dir / "art" / "x.jpg").touch()
        monkeypatch.setattr(shared, "target_dir", images_dir)
        monkeypatch.setattr(shared, "pictoria_dir", images_dir / ".pictoria")

        @asynccontextmanager
        async def _lifespan(app: Litestar):
            app.state.db = db
            yield

        app = Litestar(
            route_handlers=[Router("/v2", route_handlers=[FoldersController])],
            dependencies=REQUEST_DEPENDENCIES,
            plugins=[PydanticPlugin(prefer_alias=True)],
            lifespan=[_lifespan],
        )
        with TestClient(app=app) as client:
            yield client

    def test_folders_carries_recursive_stats(self, folders_client: TestClient) -> None:
        resp = folders_client.get("/v2/folders/")
        assert resp.status_code == 200
        root = resp.json()

        # root rolls up all 5 seeded posts
        assert root["post_count"] == 5
        assert root["silva_avg"] == pytest.approx(1.3 / 2)

        art = _find(root, "art")
        assert art is not None
        assert art["post_count"] == 2
        assert art["silva_avg"] == pytest.approx(1.3 / 2)
        assert art["score_avg"] == pytest.approx(3.0)
        assert art["rating_avg"] == pytest.approx(2.5)
        assert art["scored_ratio"] == pytest.approx(0.5)

        photos = _find(root, "photos")
        assert photos is not None
        assert photos["post_count"] == 3  # photos(1,2) + photos/sub(3)
        assert photos["silva_avg"] is None
