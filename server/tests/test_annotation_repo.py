"""Tests for annotation tables and AnnotationRepo."""

from __future__ import annotations

from typing import TYPE_CHECKING

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
