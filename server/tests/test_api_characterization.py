"""HTTP-level characterization tests for the read/write/error API surface.

These pin the *current* behaviour of the controller layer through a real
Litestar ``TestClient``, so the dependency-injection wiring (``server.dependencies``)
and the unified domain-error translation (``server.exceptions.domain_error_handler``)
are exercised end-to-end — the existing golden-master suite only reaches the
data-access layer, never the HTTP seam.

The app is assembled from the same providers, exception handler and plugins the
production app uses, but only the controllers that don't pull in the ML/processor
stack (posts / tags / statistics) and with a trivial lifespan that injects the
seeded test DB instead of running migrations + the backfill poller.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

from server.dependencies import REQUEST_DEPENDENCIES
from server.exceptions import DomainError, domain_error_handler
from server.posts import PostController
from server.statistics import StatisticsController
from server.tags import TagsController

if TYPE_CHECKING:
    from collections.abc import Iterator

    from db.connection import DB

SEEDED_POST_COUNT = 5


@pytest.fixture
def api_client(db: DB) -> Iterator[TestClient]:
    @asynccontextmanager
    async def _lifespan(app: Litestar):
        app.state.db = db
        yield

    app = Litestar(
        route_handlers=[Router("/v2", route_handlers=[PostController, TagsController, StatisticsController])],
        dependencies=REQUEST_DEPENDENCIES,
        exception_handlers={DomainError: domain_error_handler},
        plugins=[PydanticPlugin(prefer_alias=True)],
        lifespan=[_lifespan],
    )
    with TestClient(app=app) as client:
        yield client


# ─── reads: dependency wiring for every repo/query-service ──────────────────


def test_list_posts(api_client: TestClient) -> None:
    resp = api_client.get("/v2/posts/")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["items"]) == SEEDED_POST_COUNT


def test_get_post_detail(api_client: TestClient) -> None:
    resp = api_client.get("/v2/posts/1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == 1
    assert "tags" in body
    assert "colors" in body
    # post 1 has a waifu score of 8.5 in the seed data
    assert body["waifuScore"]["score"] == pytest.approx(8.5)


def test_count(api_client: TestClient) -> None:
    resp = api_client.post("/v2/posts/count", json={})
    assert resp.status_code == 200
    assert resp.json()["count"] == SEEDED_POST_COUNT


def test_count_by_rating_sums_to_total(api_client: TestClient) -> None:
    resp = api_client.post("/v2/posts/count/rating", json={})
    assert resp.status_code == 200
    assert sum(item["count"] for item in resp.json()) == SEEDED_POST_COUNT


def test_count_by_waifu_bucket(api_client: TestClient) -> None:
    resp = api_client.post("/v2/posts/count/waifu", json={})
    assert resp.status_code == 200
    buckets = {item["bucket"]: item["count"] for item in resp.json()}
    # seed: 8.5->S, 5.0->B, 3.5->C, 1.0->D, post 2 unscored
    assert buckets == {"S": 1, "B": 1, "C": 1, "D": 1, "UNSCORED": 1}


def test_stats(api_client: TestClient) -> None:
    resp = api_client.post("/v2/posts/stats", json={})
    assert resp.status_code == 200
    assert resp.json()["total"] == SEEDED_POST_COUNT


def test_search_orders_by_id_asc(api_client: TestClient) -> None:
    resp = api_client.post("/v2/posts/search", json={"order_by": "id", "order": "asc"})
    assert resp.status_code == 200
    ids = [row["id"] for row in resp.json()]
    assert ids == sorted(ids)
    assert len(ids) == SEEDED_POST_COUNT


def test_statistics_histogram(api_client: TestClient) -> None:
    resp = api_client.get("/v2/statistics/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_list_tags(api_client: TestClient) -> None:
    resp = api_client.get("/v2/tags/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_tag_groups(api_client: TestClient) -> None:
    resp = api_client.get("/v2/tags/groups")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


# ─── writes ─────────────────────────────────────────────────────────────────


def test_update_score(api_client: TestClient) -> None:
    resp = api_client.put("/v2/posts/1/score", json={"score": 4})
    assert resp.status_code == 200
    assert resp.json()["score"] == 4


def test_bulk_update_rating_ok(api_client: TestClient) -> None:
    resp = api_client.put("/v2/posts/bulk/rating", params={"ids": [1, 2], "rating": 1})
    assert resp.status_code in (200, 204)
    detail = api_client.get("/v2/posts/1").json()
    assert detail["rating"] == 1


# ─── unified domain-error translation (C3) ─────────────────────────────────


def test_get_missing_post_returns_unified_404(api_client: TestClient) -> None:
    resp = api_client.get("/v2/posts/999999")
    assert resp.status_code == 404
    assert resp.json() == {
        "detail": "Post with id 999999 not found.",
        "error": "PostNotFoundError",
    }


def test_invalid_pagination_returns_unified_error(api_client: TestClient) -> None:
    resp = api_client.get("/v2/posts/", params={"start": -1})
    assert resp.json()["error"] == "InvalidArgumentError"


def test_rating_out_of_range_returns_unified_error(api_client: TestClient) -> None:
    resp = api_client.put("/v2/posts/1/rating", params={"rating": 9999})
    assert resp.json()["error"] == "InvalidArgumentError"


def test_bulk_rating_out_of_range_returns_unified_error(api_client: TestClient) -> None:
    resp = api_client.put("/v2/posts/bulk/rating", params={"ids": [1], "rating": 9999})
    assert resp.json()["error"] == "InvalidArgumentError"


def test_create_existing_tag_returns_unified_conflict(api_client: TestClient) -> None:
    resp = api_client.post("/v2/tags/", json={"name": "artist_a"})
    assert resp.status_code == 409
    assert resp.json()["error"] == "TagNameExistsError"
