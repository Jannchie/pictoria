"""HTTP tests for annotation + queue endpoints."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
import sqlite_vec
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


def test_create_and_consume_absolute_queue(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotation-queues/absolute",
        json={"name": "coldstart-1", "dimensions": ["color", "finish"], "scale": 2, "post_ids": [1, 2]},
    )
    assert resp.status_code == 201
    qid = resp.json()["id"]

    resp = api_client.get("/v2/annotation-queues")
    assert resp.status_code == 200
    queues = resp.json()
    assert queues[0]["name"] == "coldstart-1"
    assert queues[0]["total"] == 2
    assert queues[0]["done"] == 0

    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-absolute?limit=10")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    assert items[0]["post"]["id"] == 1

    # 提交事件并标记 done 后，next 不再返回该 item
    api_client.post(
        "/v2/annotations/absolute",
        json={
            "events": [
                {"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"},
                {"post_id": 1, "dimension": "finish", "scale": 2, "value": 1, "rubric_version": "finish-v1", "session_id": "s1"},
            ],
            "queue_id": qid,
            "queue_position": 0,
        },
    )
    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-absolute?limit=10")
    assert len(resp.json()) == 1


def test_stream_sample_absolute(api_client: TestClient, db: DB) -> None:
    cur = db.cursor()
    for pid in (1, 2, 3):
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, sqlite_vec.serialize_float32([0.01 * pid] * 1152)],
        )
    resp = api_client.get("/v2/annotations/sample-absolute?dimensions=color&dimensions=finish&strategy=random&limit=10")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 3
    assert {"id", "filePath", "fileName", "extension", "sha256"} <= set(items[0])

    # 标注 color 后该图不再被采样到
    api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": items[0]["id"], "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"}]},
    )
    resp = api_client.get("/v2/annotations/sample-absolute?dimensions=color&strategy=random&limit=10")
    assert items[0]["id"] not in [r["id"] for r in resp.json()]


def test_stream_sample_pairwise(api_client: TestClient, db: DB) -> None:
    cur = db.cursor()
    for pid in (1, 2, 3, 4):
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, sqlite_vec.serialize_float32([0.01 * pid] * 1152)],
        )
    resp = api_client.get("/v2/annotations/sample-pairwise?limit=2")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    assert items[0]["postA"]["id"] != items[0]["postB"]["id"]


def test_stream_sample_pairwise_similar(api_client: TestClient, db: DB) -> None:
    cur = db.cursor()
    for pid in (1, 2, 3, 4, 5):  # orthogonal embeddings -> all mutual neighbours
        vec = [0.0] * 1152
        vec[pid % 1152] = 1.0
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, sqlite_vec.serialize_float32(vec)])
    resp = api_client.get("/v2/annotations/sample-pairwise?limit=2&strategy=similar")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    for it in items:
        assert it["postA"]["id"] != it["postB"]["id"]


def test_sample_pairwise_rejects_bad_strategy(api_client: TestClient) -> None:
    resp = api_client.get("/v2/annotations/sample-pairwise?limit=2&strategy=bogus")
    assert resp.status_code == 400


def test_generate_absolute_queue(api_client: TestClient, db: DB) -> None:
    # seed embeddings so posts 1-3 qualify as candidates
    cur = db.cursor()
    for pid in (1, 2, 3):
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, sqlite_vec.serialize_float32([0.01 * pid] * 1152)],
        )

    resp = api_client.post(
        "/v2/annotation-queues/generate-absolute",
        json={"dimensions": ["color", "finish"], "scale": 2, "count": 2, "strategy": "random"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["total"] == 2
    assert body["kind"] == "absolute"

    resp = api_client.get(f"/v2/annotation-queues/{body['id']}/next-absolute?limit=10")
    assert len(resp.json()) == 2


def test_generate_pairwise_queue(api_client: TestClient, db: DB) -> None:
    cur = db.cursor()
    for pid in (1, 2, 3, 4):
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, sqlite_vec.serialize_float32([0.01 * pid] * 1152)],
        )

    resp = api_client.post(
        "/v2/annotation-queues/generate-pairwise",
        json={"dimension": "color", "count": 2},
    )
    assert resp.status_code == 201
    assert resp.json()["total"] == 2


def test_generate_with_no_candidates_rejected(api_client: TestClient) -> None:
    # seed DB 没有任何 embedding -> 无候选
    resp = api_client.post(
        "/v2/annotation-queues/generate-absolute",
        json={"dimensions": ["color"], "scale": 2, "count": 5, "strategy": "random"},
    )
    assert resp.status_code == 400


def test_create_and_consume_pairwise_queue(api_client: TestClient) -> None:
    resp = api_client.post(
        "/v2/annotation-queues/pairwise",
        json={"name": "pairs-1", "dimensions": ["color"], "pairs": [[1, 2], [2, 3]]},
    )
    assert resp.status_code == 201
    qid = resp.json()["id"]

    resp = api_client.get(f"/v2/annotation-queues/{qid}/next-pairwise?limit=10")
    items = resp.json()
    assert len(items) == 2
    assert items[0]["postA"]["id"] == 1
    assert items[0]["postB"]["id"] == 2
