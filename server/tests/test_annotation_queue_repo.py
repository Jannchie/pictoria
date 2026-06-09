"""Tests for AnnotationQueueRepo."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
import sqlite_vec

from db.repositories.annotation_queues import AnnotationQueueRepo
from db.repositories.annotations import AnnotationRepo

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


def _seed_embeddings(db: DB, post_ids: list[int]) -> None:
    cur = db.cursor()
    for pid in post_ids:
        blob = sqlite_vec.serialize_float32([0.01 * pid] * 1152)
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, blob])


async def test_sample_random_requires_embedding(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])  # posts 4/5 没有 embedding
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert set(ids) <= {1, 2, 3}
    assert len(ids) == 3


async def test_sample_excludes_already_annotated(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_absolute(post_id=2, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 2 not in ids
    # 但只标过别的维度不排除
    ids_finish = await queues.sample_post_ids(count=10, strategy="random", dimensions=["finish"])
    assert 2 in ids_finish


async def test_sample_excludes_pending_queue_items(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3])
    qid = await queues.create_absolute_queue(name="q", dimensions=["color"], scale=2, post_ids=[1])
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 1 not in ids  # 已在未完成队列里
    await queues.mark_done(qid, kind="absolute", position=0)
    # done 后不再因排队被排除（但仍可能因已标注被排除——本例没有提交事件所以可入选）
    ids = await queues.sample_post_ids(count=10, strategy="random", dimensions=["color"])
    assert 1 in ids


async def test_sample_stratified_covers_score_levels(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4, 5])  # seed posts: score 3/0/5/0/3
    ids = await queues.sample_post_ids(count=4, strategy="stratified", dimensions=["color"])
    assert len(ids) == 4
    # 有分的层（3 和 5）必须被覆盖
    cur = db.cursor()
    cur.execute(f"SELECT DISTINCT score FROM posts WHERE id IN ({','.join('?' * len(ids))})", ids)
    scores = {row[0] for row in cur.fetchall()}
    assert 3 in scores
    assert 5 in scores


async def test_sample_pairs_random(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4, 5])
    pairs = await queues.sample_pairs(count=2, strategy="random")
    assert len(pairs) == 2
    flat = [p for pair in pairs for p in pair]
    assert len(flat) == len(set(flat))  # 一图最多出现一次
    for a, b in pairs:
        assert a != b


def _seed_distinct_embeddings(db: DB, post_ids: list[int]) -> None:
    """One-hot embeddings: every pair is orthogonal (cosine distance ~1), so
    the similar-pair KNN treats all seeded posts as mutual neighbours and none
    get dropped as near-duplicates — pairing is then driven purely by score."""
    cur = db.cursor()
    for pid in post_ids:
        vec = [0.0] * 1152
        vec[pid % 1152] = 1.0
        cur.execute("INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)", [pid, sqlite_vec.serialize_float32(vec)])


async def test_sample_pairs_similar_respects_score_band(db: DB, queues: AnnotationQueueRepo) -> None:
    # fixture scores: 1->3, 2->0, 3->5, 4->0, 5->3. All five are mutual
    # neighbours, so pairing is driven by the score band: 1 & 5 (both 3) pair,
    # 2 & 4 (unrated) pair, and 3 (score 5) has no same/adjacent-score partner
    # so it must be stranded rather than forced into a foregone 5-vs-3.
    _seed_distinct_embeddings(db, [1, 2, 3, 4, 5])
    pairs = await queues.sample_pairs(count=2, strategy="similar")
    assert len(pairs) == 2
    flat = [p for pair in pairs for p in pair]
    assert len(flat) == len(set(flat))  # disjoint
    for a, b in pairs:
        assert a != b
    assert 3 not in flat  # score-5 post has no in-band partner (1/5 are score 3)
    score = {1: 3, 2: 0, 3: 5, 4: 0, 5: 3}
    for a, b in pairs:
        if score[a] and score[b]:  # both rated -> must be same/adjacent bucket
            assert abs(score[a] - score[b]) <= 1


async def test_sample_absolute_items_carry_image_fields(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2])
    items = await queues.sample_absolute_items(count=10, strategy="random", dimensions=["color"])
    assert len(items) == 2
    assert {"post_id", "file_path", "file_name", "extension", "sha256", "width", "height"} <= set(items[0])


async def test_sample_pairwise_items_carry_image_fields(db: DB, queues: AnnotationQueueRepo) -> None:
    _seed_embeddings(db, [1, 2, 3, 4])
    items = await queues.sample_pairwise_items(count=2)
    assert len(items) == 2
    assert "a_post_id" in items[0]
    assert "b_file_name" in items[0]
