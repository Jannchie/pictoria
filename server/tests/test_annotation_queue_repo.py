"""Tests for AnnotationQueueRepo."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from db.repositories.annotation_queues import AnnotationQueueRepo

if TYPE_CHECKING:
    from db.connection import DB


@pytest.fixture
def queues(db: DB) -> AnnotationQueueRepo:
    return AnnotationQueueRepo(db.cursor())


async def test_create_and_list_absolute_queue(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(
        name="coldstart-1", dimensions=["color", "finish", "composition"], scale=2, post_ids=[1, 2, 3],
    )
    assert qid > 0
    rows = await queues.list_queues()
    assert len(rows) == 1
    queue, total, done = rows[0]
    assert queue.name == "coldstart-1"
    assert queue.kind == "absolute"
    assert queue.dimensions == ["color", "finish", "composition"]
    assert queue.scale == 2
    assert total == 3
    assert done == 0


async def test_next_absolute_items_and_mark_done(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_absolute_queue(name="q", dimensions=["color"], scale=2, post_ids=[1, 2])
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [0, 1]
    assert items[0]["post_id"] == 1
    assert "file_name" in items[0]  # join posts，前端拼图片 URL 用

    await queues.mark_done(qid, kind="absolute", position=0)
    items = await queues.next_absolute_items(qid, limit=10)
    assert [i["position"] for i in items] == [1]


async def test_pairwise_queue_roundtrip(queues: AnnotationQueueRepo) -> None:
    qid = await queues.create_pairwise_queue(name="pq", dimensions=["color"], pairs=[(1, 2), (2, 3)])
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 2
    assert items[0]["a_post_id"] == 1
    assert items[0]["b_post_id"] == 2
    await queues.mark_done(qid, kind="pairwise", position=0)
    items = await queues.next_pairwise_items(qid, limit=10)
    assert len(items) == 1
