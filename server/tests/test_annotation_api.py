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


def test_undo_pairwise_removes_the_event_entirely(api_client: TestClient) -> None:
    """A retracted mis-click must not survive anywhere a consumer can see it.

    Not merely "the history endpoint stops showing it": the sampler reads the raw table to
    decide a pair was already asked, and the training export emits one row per judgement.
    """
    submitted = api_client.post(
        "/v2/annotations/pairwise",
        json={"post_a": 1, "post_b": 2, "dimension": "color", "winner": "b", "rubric_version": "color-v1", "session_id": "s1"},
    ).json()
    assert submitted["ids"], "submit must hand back the row id, or undo has nothing to aim at"

    resp = api_client.post("/v2/annotations/undo", json={"kind": "pairwise", "ids": submitted["ids"], "session_id": "s1"})
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 1
    assert api_client.get("/v2/annotations/post/1").json()["pairwise"] == []
    assert api_client.get("/v2/annotations/pairwise/count", params={"dimension": "color"}).json()["total"] == 0


def test_undo_only_reaches_its_own_session(api_client: TestClient) -> None:
    """The id alone must not be enough — otherwise a stale client can delete live work."""
    ids = api_client.post(
        "/v2/annotations/pairwise",
        json={"post_a": 1, "post_b": 2, "dimension": "color", "winner": "b", "rubric_version": "color-v1", "session_id": "s1"},
    ).json()["ids"]
    resp = api_client.post("/v2/annotations/undo", json={"kind": "pairwise", "ids": ids, "session_id": "someone-else"})
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 0
    assert len(api_client.get("/v2/annotations/post/1").json()["pairwise"]) == 1


def test_undo_absolute_removes_every_dimension_of_one_image(api_client: TestClient) -> None:
    ids = api_client.post(
        "/v2/annotations/absolute",
        json={
            "events": [
                {"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"},
                {"post_id": 1, "dimension": "finish", "scale": 2, "value": 1, "rubric_version": "finish-v1", "session_id": "s1"},
            ],
        },
    ).json()["ids"]
    assert len(ids) == 2
    assert api_client.post("/v2/annotations/undo", json={"kind": "absolute", "ids": ids, "session_id": "s1"}).json()["deleted"] == 2
    assert api_client.get("/v2/annotations/post/1").json()["absolute"] == []


def test_undo_reopens_the_queue_item(api_client: TestClient) -> None:
    """Undo of a queue judgement has to put the item BACK in the queue, not just drop the row."""
    queue_id = api_client.post(
        "/v2/annotation-queues/pairwise",
        json={"name": "q", "dimensions": ["color"], "pairs": [[1, 2]]},
    ).json()["id"]
    ids = api_client.post(
        "/v2/annotations/pairwise",
        json={
            "post_a": 1, "post_b": 2, "dimension": "color", "winner": "a", "rubric_version": "color-v1",
            "session_id": "s1", "queue_id": queue_id, "queue_position": 0,
        },
    ).json()["ids"]
    assert api_client.get(f"/v2/annotation-queues/{queue_id}/next-pairwise").json() == []

    api_client.post(
        "/v2/annotations/undo",
        json={"kind": "pairwise", "ids": ids, "session_id": "s1", "queue_id": queue_id, "queue_position": 0},
    )
    assert len(api_client.get(f"/v2/annotation-queues/{queue_id}/next-pairwise").json()) == 1


def test_undo_of_a_skipped_queue_item_carries_no_event(api_client: TestClient) -> None:
    """Skipping marks the item done without writing an event, so its undo is the un-marking alone."""
    queue_id = api_client.post(
        "/v2/annotation-queues/pairwise",
        json={"name": "q", "dimensions": ["color"], "pairs": [[1, 2]]},
    ).json()["id"]
    api_client.post(
        "/v2/annotations/absolute",
        json={"events": [], "queue_id": queue_id, "queue_position": 0},
    )
    resp = api_client.post(
        "/v2/annotations/undo",
        json={"kind": "pairwise", "ids": [], "session_id": "s1", "queue_id": queue_id, "queue_position": 0},
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 0
    assert len(api_client.get(f"/v2/annotation-queues/{queue_id}/next-pairwise").json()) == 1


def test_undo_rejects_an_unknown_kind(api_client: TestClient) -> None:
    resp = api_client.post("/v2/annotations/undo", json={"kind": "content_flag", "ids": [1], "session_id": "s1"})
    assert resp.status_code == 400


def _judge(client: TestClient, a: int, b: int, winner: str = "a", session: str = "s1") -> int:
    return client.post(
        "/v2/annotations/pairwise",
        json={"post_a": a, "post_b": b, "dimension": "color", "winner": winner, "rubric_version": "color-v1", "session_id": session},
    ).json()["ids"][0]


def _page(client: TestClient, *, limit: int = 30, before: str | None = None) -> dict:
    return client.get("/v2/annotations/timeline", params={"limit": limit, **({"before": before} if before else {})}).json()


def test_timeline_merges_all_three_event_kinds_newest_first(api_client: TestClient) -> None:
    _judge(api_client, 1, 2)
    api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "color", "scale": 2, "value": 2, "rubric_version": "color-v1", "session_id": "s1"}]},
    )
    api_client.post("/v2/annotations/content-flag", json={"post_id": 2, "flag": "love", "session_id": "s1"})

    items = _page(api_client)["items"]
    assert {i["kind"] for i in items} == {"pairwise", "absolute", "flag"}
    pair = next(i for i in items if i["kind"] == "pairwise")
    assert pair["postB"] is not None, "对比这一条要能渲染出两张图"
    assert pair["post"]["id"] == 1 and pair["postB"]["id"] == 2
    assert next(i for i in items if i["kind"] == "absolute")["postB"] is None
    assert next(i for i in items if i["kind"] == "flag")["flag"] == "love"


def test_timeline_cursor_does_not_repeat_rows_written_while_paging(api_client: TestClient) -> None:
    """The head of this list grows while it is scrolled — that is what rules OFFSET out.

    Every event here lands in the same ``datetime('now')`` second, so this also pins the
    (created_at, kind, id) tiebreak: with created_at alone the cursor could not separate
    them and the second page would resend the first.
    """
    first_batch = [_judge(api_client, 1, 2), _judge(api_client, 2, 3), _judge(api_client, 3, 4)]

    page1 = _page(api_client, limit=2)
    assert len(page1["items"]) == 2
    assert page1["nextCursor"]

    # ... and now the rater keeps judging, inserting ahead of the cursor.
    later = [_judge(api_client, 1, 4), _judge(api_client, 2, 4)]

    page2 = _page(api_client, limit=2, before=page1["nextCursor"])
    seen = [i["id"] for i in page1["items"]] + [i["id"] for i in page2["items"]]
    assert len(seen) == len(set(seen)), f"翻页把已经看过的行又发了一遍 {seen}"
    assert all(i not in seen for i in later), "游标之后写入的行不该倒插进后续页"
    assert set(seen) <= set(first_batch)


def test_timeline_walks_the_whole_stream_exactly_once(api_client: TestClient) -> None:
    # Pairs among the seeded posts 1..5 only — an event whose post is gone is dropped
    # from the page on purpose (see test below), which would make this count wrong.
    written = [_judge(api_client, a, b) for a, b in [(1, 2), (1, 3), (1, 4), (1, 5), (2, 3), (2, 4), (2, 5)]]
    seen: list[int] = []
    cursor = None
    while True:
        page = _page(api_client, limit=3, before=cursor)
        seen += [i["id"] for i in page["items"]]
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert sorted(seen) == sorted(written)


def test_timeline_drops_events_whose_picture_is_gone(api_client: TestClient) -> None:
    """A judgement outlives its picture; a row with nothing to render is worse than absent.

    It also means a page can come back shorter than the limit and STILL have more behind
    it, which is why nextCursor keys off the raw event count and not off len(items).
    """
    kept = _judge(api_client, 1, 2)
    _judge(api_client, 1, 404)  # 404 was never seeded

    page = _page(api_client, limit=2)
    assert [i["id"] for i in page["items"]] == [kept]
    assert page["nextCursor"], "整页原始事件被取满了，后面可能还有，不能报告到底了"


def test_timeline_rejects_a_malformed_cursor(api_client: TestClient) -> None:
    assert api_client.get("/v2/annotations/timeline", params={"before": "garbage"}).status_code == 400


def test_edit_rewrites_the_verdict_in_place_and_stamps_edited_at(api_client: TestClient) -> None:
    """In place, not appended: an appended correction leaves the wrong row in the export."""
    annotation_id = _judge(api_client, 1, 2, winner="a")
    resp = api_client.patch(f"/v2/annotations/pairwise/{annotation_id}", json={"verdict": "tie"})
    assert resp.status_code == 200

    history = api_client.get("/v2/annotations/post/1").json()["pairwise"]
    assert len(history) == 1, "改判不该多出一条事件"
    assert history[0]["id"] == annotation_id
    assert history[0]["winner"] == "tie"
    assert history[0]["editedAt"] is not None, "elapsed_ms 对改过的行已经不成立，要有标记"
    counts = api_client.get("/v2/annotations/pairwise/count", params={"dimension": "color"}).json()
    assert counts["decisive"] == 0 and counts["tie"] == 1


def test_edit_absolute_changes_the_value(api_client: TestClient) -> None:
    ids = api_client.post(
        "/v2/annotations/absolute",
        json={"events": [{"post_id": 1, "dimension": "color", "scale": 5, "value": 2, "rubric_version": "color-v1", "session_id": "s1"}]},
    ).json()["ids"]
    assert api_client.patch(f"/v2/annotations/absolute/{ids[0]}", json={"verdict": 5}).status_code == 200
    assert api_client.get("/v2/annotations/post/1").json()["absolute"][0]["value"] == 5


def test_edit_rejects_a_verdict_the_column_cannot_hold(api_client: TestClient) -> None:
    annotation_id = _judge(api_client, 1, 2)
    assert api_client.patch(f"/v2/annotations/pairwise/{annotation_id}", json={"verdict": "maybe"}).status_code == 400
    assert api_client.patch(f"/v2/annotations/flag/{annotation_id}", json={"verdict": "love"}).status_code == 400


def test_edit_of_a_missing_row_changes_nothing(api_client: TestClient) -> None:
    assert api_client.patch("/v2/annotations/pairwise/999999", json={"verdict": "tie"}).json()["updated"] == 0


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
    resp = api_client.get("/v2/annotations/sample-pairwise?limit=2&strategy=random")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    assert items[0]["postA"]["id"] != items[0]["postB"]["id"]


def test_stream_sample_pairwise_defaults_to_close(api_client: TestClient, db: DB) -> None:
    """The default strategy has to be the one worth spending annotations on.

    A random pair is usually a foregone verdict; 'close' spends the same minute on pairs
    the model cannot separate, which is the only kind that teaches it anything. A caller
    that names no strategy should get that one.
    """
    cur = db.cursor()
    cur.execute("DELETE FROM post_aesthetic_scores")  # drop the fixture's preset scores
    for pid in (1, 2, 3, 4):
        vec = [0.0] * 1152
        vec[pid % 1152] = 1.0  # orthogonal -> mutual neighbours, none dropped as near-duplicates
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, sqlite_vec.serialize_float32(vec)])
        cur.execute("INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, 'silva', ?)", [pid, 0.40 + pid * 0.01])

    items = api_client.get("/v2/annotations/sample-pairwise?limit=2").json()
    assert len(items) == 2
    # scores are 0.01 apart per id, so an in-band edge spans at most 10 ids
    for it in items:
        assert abs(it["postA"]["id"] - it["postB"]["id"]) <= 10


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
