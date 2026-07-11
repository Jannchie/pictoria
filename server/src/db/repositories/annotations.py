"""Append-only annotation event repository (absolute / pairwise / content-flag).

Events are never updated or deleted: re-annotating the same (post, dimension)
appends a new row, and exports aggregate latest-wins. Repeated rows double as
free intra-rater retest data.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from db.asyncbridge import in_thread
from db.entities import AbsoluteAnnotation, ContentFlagEvent, PairwiseAnnotation
from db.helpers import fetch_all_as, fetch_one_as

if TYPE_CHECKING:
    import sqlite3

ABSOLUTE_COLUMNS = "id, created_at, post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms"
PAIRWISE_COLUMNS = "id, created_at, post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms"
FLAG_COLUMNS = "id, created_at, post_id, flag, session_id"


class AnnotationRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    @in_thread
    def insert_absolute(  # noqa: PLR0913  # one kwarg per event column
        self,
        *,
        post_id: int,
        dimension: str,
        scale: int,
        value: int,
        rubric_version: str,
        session_id: str,
        elapsed_ms: int | None = None,
    ) -> int:
        self.cur.execute(
            "INSERT INTO absolute_annotations (post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms],
        )
        return int(self.cur.lastrowid or 0)

    @in_thread
    def insert_pairwise(  # noqa: PLR0913  # one kwarg per event column
        self,
        *,
        post_a: int,
        post_b: int,
        dimension: str,
        winner: str,
        rubric_version: str,
        session_id: str,
        elapsed_ms: int | None = None,
    ) -> int:
        self.cur.execute(
            "INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms],
        )
        return int(self.cur.lastrowid or 0)

    @in_thread
    def insert_content_flag(self, *, post_id: int, flag: str, session_id: str) -> int:
        self.cur.execute(
            "INSERT INTO content_flag_events (post_id, flag, session_id) VALUES (?, ?, ?)",
            [post_id, flag, session_id],
        )
        return int(self.cur.lastrowid or 0)

    @in_thread
    def list_absolute_for_post(self, post_id: int) -> list[AbsoluteAnnotation]:
        self.cur.execute(
            f"SELECT {ABSOLUTE_COLUMNS} FROM absolute_annotations WHERE post_id = ? ORDER BY id",  # noqa: S608
            [post_id],
        )
        return fetch_all_as(self.cur, AbsoluteAnnotation)

    @in_thread
    def list_pairwise_for_post(self, post_id: int) -> list[PairwiseAnnotation]:
        self.cur.execute(
            f"SELECT {PAIRWISE_COLUMNS} FROM pairwise_annotations WHERE post_a = ? OR post_b = ? ORDER BY id",  # noqa: S608
            [post_id, post_id],
        )
        return fetch_all_as(self.cur, PairwiseAnnotation)

    @in_thread
    def count_pairwise(self, dimension: str) -> dict[str, int]:
        """Cumulative pairwise judgement counts for a dimension.

        ``total`` is decisive (a/b) + tie — the judgements that carry signal;
        skips are an empty-pool / sampling reaction, not a label, so they're
        reported separately and excluded from ``total``.
        """
        self.cur.execute(
            "SELECT winner, COUNT(*) FROM pairwise_annotations WHERE dimension = ? GROUP BY winner",
            [dimension],
        )
        by = dict(self.cur.fetchall())
        decisive = by.get("a", 0) + by.get("b", 0)
        tie = by.get("tie", 0)
        return {"total": decisive + tie, "decisive": decisive, "tie": tie, "skip": by.get("skip", 0)}

    @in_thread
    def latest_content_flag(self, post_id: int) -> ContentFlagEvent | None:
        self.cur.execute(
            f"SELECT {FLAG_COLUMNS} FROM content_flag_events WHERE post_id = ? ORDER BY id DESC LIMIT 1",  # noqa: S608
            [post_id],
        )
        return fetch_one_as(self.cur, ContentFlagEvent)
