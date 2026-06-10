"""Tests for annotation tables and AnnotationRepo."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from db.repositories.annotations import AnnotationRepo

if TYPE_CHECKING:
    from db.connection import DB


def _table_names(db: DB) -> set[str]:
    cur = db.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    return {row[0] for row in cur.fetchall()}


def test_annotation_tables_exist(db: DB) -> None:
    names = _table_names(db)
    assert "absolute_annotations" in names
    assert "pairwise_annotations" in names
    assert "content_flag_events" in names
    assert "annotation_queues" in names
    assert "absolute_queue_items" in names
    assert "pairwise_queue_items" in names
    assert "annotation_timeline" in names  # view


@pytest.fixture
def annotations(db: DB) -> AnnotationRepo:
    return AnnotationRepo(db.cursor())


async def test_insert_and_list_absolute(annotations: AnnotationRepo) -> None:
    eid = await annotations.insert_absolute(
        post_id=1, dimension="color", scale=2, value=2,
        rubric_version="color-v1", session_id="s1", elapsed_ms=1234,
    )
    assert eid > 0
    rows = await annotations.list_absolute_for_post(1)
    assert len(rows) == 1
    assert rows[0].dimension == "color"
    assert rows[0].scale == 2
    assert rows[0].value == 2
    assert rows[0].elapsed_ms == 1234


async def test_absolute_is_append_only(annotations: AnnotationRepo) -> None:
    await annotations.insert_absolute(post_id=1, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    await annotations.insert_absolute(post_id=1, dimension="color", scale=2, value=2, rubric_version="color-v1", session_id="s2")
    rows = await annotations.list_absolute_for_post(1)
    assert len(rows) == 2  # 重复标注追加而非覆盖


async def test_insert_and_list_pairwise(annotations: AnnotationRepo) -> None:
    eid = await annotations.insert_pairwise(
        post_a=1, post_b=2, dimension="composition", winner="a",
        rubric_version="composition-v1", session_id="s1", elapsed_ms=2000,
    )
    assert eid > 0
    rows = await annotations.list_pairwise_for_post(2)  # post_b 也能查到
    assert len(rows) == 1
    assert rows[0].winner == "a"


async def test_count_pairwise(annotations: AnnotationRepo) -> None:
    for winner in ("a", "b", "b", "tie", "skip"):
        await annotations.insert_pairwise(post_a=1, post_b=2, dimension="overall", winner=winner, rubric_version="overall-v1", session_id="s1")
    # a different dimension must not leak into the overall count
    await annotations.insert_pairwise(post_a=1, post_b=2, dimension="color", winner="a", rubric_version="color-v1", session_id="s1")
    c = await annotations.count_pairwise("overall")
    assert c == {"total": 4, "decisive": 3, "tie": 1, "skip": 1}  # total = decisive + tie; skip excluded


async def test_content_flag_latest(annotations: AnnotationRepo) -> None:
    assert await annotations.latest_content_flag(1) is None
    await annotations.insert_content_flag(post_id=1, flag="love", session_id="s1")
    await annotations.insert_content_flag(post_id=1, flag="none", session_id="s1")
    latest = await annotations.latest_content_flag(1)
    assert latest is not None
    assert latest.flag == "none"
