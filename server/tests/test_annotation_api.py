"""HTTP tests for annotation + queue endpoints."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
from litestar import Litestar, Router
from litestar.plugins.pydantic import PydanticPlugin
from litestar.testing import TestClient

from server.annotation_queues import AnnotationQueueController
from server.annotations import AnnotationController
from server.dependencies import REQUEST_DEPENDENCIES
from server.exceptions import DomainError, domain_error_handler

if TYPE_CHECKING:
    from collections.abc import Iterator

    from db.connection import DB


@pytest.fixture
def api_client(db: DB) -> Iterator[TestClient]:
    @asynccontextmanager
    async def _lifespan(app: Litestar):
        app.state.db = db
        yield

    app = Litestar(
        route_handlers=[Router("/v2", route_handlers=[AnnotationController, AnnotationQueueController])],
        dependencies=REQUEST_DEPENDENCIES,
        exception_handlers={DomainError: domain_error_handler},
        plugins=[PydanticPlugin(prefer_alias=True)],
        lifespan=[_lifespan],
    )
    with TestClient(app=app) as client:
        yield client


def test_submit_absolute_batch(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/absolute",
        json={
            "events": [
                {"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1", "elapsed_ms": 900},
                {"post_id": 1, "dimension": "finish", "scale": 2, "value": 1, "rubric_version": "finish-v1", "session_id": "s1", "elapsed_ms": 400},
            ],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["inserted"] == 2


def test_submit_pairwise(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/pairwise",
        json={"post_a": 1, "post_b": 2, "dimension": "color", "winner": "b", "rubric_version": "color-v1", "session_id": "s1"},
    )
    assert resp.status_code == 201


def test_submit_content_flag(api_client: TestClient) -> None:
    resp = api_client.post("/v2/annotations/content-flag", json={"post_id": 1, "flag": "love", "session_id": "s1"})
    assert resp.status_code == 201


def test_invalid_dimension_rejected(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "vibes", "scale": 2, "value": 1, "rubric_version": "v1", "session_id": "s1"}]},
    )
    assert resp.status_code == 400


def test_post_annotation_history(api_client: TestClient) -> None:
    api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"}]},
    )
    api_client.post("/v2/annotations/content-flag", json={"post_id": 1, "flag": "hate", "session_id": "s1"})
    resp = api_client.get("/v2/annotations/post/1")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["absolute"]) == 1
    assert body["absolute"][0]["dimension"] == "color"
    assert body["contentFlag"] == "hate"
