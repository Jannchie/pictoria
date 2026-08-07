"""Append-only annotation event repository (absolute / pairwise / content-flag).

Events are never updated: re-annotating the same (post, dimension) appends a new
row, and exports aggregate latest-wins. Repeated rows double as free intra-rater
retest data.

Two operations break that, both for the same reason and both deliberately:
:meth:`AnnotationRepo.undo` DELETEs and :meth:`AnnotationRepo.edit` UPDATEs in
place. ``scripts/export_annotations.py`` emits one row per pairwise judgement
with no latest-wins pass, and ``AnnotationQueueRepo._judged_graph`` treats a pair
as asked forever after — so a retracted or corrected verdict that stays in the
table stays in the training set. Marking it instead of rewriting it would put a
filter obligation on every one of those readers, and missing one fails silently,
in the training data.

The cost is that id order is no longer judgement order for a corrected row, and
``elapsed_ms`` no longer describes it. ``edited_at`` (migration 0014) is what
makes those rows findable; the migration carries the full reasoning.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from db.asyncbridge import in_thread
from db.entities import AbsoluteAnnotation, ContentFlagEvent, PairwiseAnnotation
from db.helpers import fetch_all_as, fetch_all_dicts, fetch_one_as, sql_placeholders

if TYPE_CHECKING:
    import sqlite3

ABSOLUTE_COLUMNS = "id, created_at, post_id, dimension, scale, value, rubric_version, session_id, elapsed_ms, edited_at"
PAIRWISE_COLUMNS = "id, created_at, post_a, post_b, dimension, winner, rubric_version, session_id, elapsed_ms, edited_at"
FLAG_COLUMNS = "id, created_at, post_id, flag, session_id"

# Event kinds a rater can retract or correct, as a code-level allowlist — the values
# reach a table and a column name, so they must never be caller input.
#
# The rule for admission is "some consumer reads this stream one row per event", which
# is what makes a wrong row cost something. Both of these are read that way by
# ``scripts/export_annotations.py``. Content flags are not: nothing reads them but
# ``latest_content_flag``, and 'none' is already their retraction — one more event
# rather than the removal of one. A fourth stream joins here when it acquires a
# per-row consumer, not because it happens to be annotation-shaped.
_MUTABLE = {
    "absolute": ("absolute_annotations", "value"),
    "pairwise": ("pairwise_annotations", "winner"),
}
MUTABLE_KINDS = frozenset(_MUTABLE)  # the controller validates against this

# The three event streams as one list, newest first. Column shape is shared so the
# UNION type-checks; the per-kind columns are NULL in the rows that lack them.
#
# ``kind`` is in the sort key, not just the payload: created_at is second-resolution
# (``datetime('now')``) and a rater produces roughly one event a second, so ties are
# the normal case rather than the edge case, and ids only increase WITHIN a table.
# (created_at, kind, id) is the coarsest triple that totally orders the merged stream,
# which is what lets the cursor below be exact instead of approximately right.
_TIMELINE_SQL = """
SELECT id, created_at, 'pairwise' AS kind, post_a AS post, post_b, dimension,
       winner, NULL AS scale, NULL AS value, NULL AS flag, edited_at
  FROM pairwise_annotations
UNION ALL
SELECT id, created_at, 'absolute', post_id, NULL, dimension,
       NULL, scale, value, NULL, edited_at
  FROM absolute_annotations
UNION ALL
SELECT id, created_at, 'flag', post_id, NULL, NULL,
       NULL, NULL, NULL, flag, NULL
  FROM content_flag_events
"""



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
    def undo(self, *, kind: str, ids: list[int], session_id: str) -> int:
        """Delete events this session just wrote. Returns how many rows went.

        ``session_id`` is a guard, not a lookup key: the caller already knows the
        ids, and requiring the session to match means a stale client cannot reach
        into another session's history. Ids that do not match are silently not
        deleted, so a partially-applied undo reports the count it achieved rather
        than raising over a row that was never there.
        """
        table, _ = _MUTABLE[kind]
        if not ids:
            return 0
        self.cur.execute(
            f"DELETE FROM {table} WHERE session_id = ? AND id IN ({sql_placeholders(ids)})",  # noqa: S608
            [session_id, *ids],
        )
        return self.cur.rowcount

    @in_thread
    def timeline(self, *, limit: int, before: tuple[str, str, int] | None = None) -> list[dict[str, Any]]:
        """One page of the merged event stream, newest first.

        Cursor rather than OFFSET because the head of this list is being written while
        the reader scrolls it: every judgement submitted during a session shifts every
        offset by one, so page 2 fetched a few seconds after page 1 would repeat rows it
        already showed. ``before`` is the (created_at, kind, id) of the last row the
        client holds, and the row-value comparison resumes strictly after it whatever
        landed in front.

        Posts are NOT joined here. The stream is a UNION of three tables and the caller
        needs image fields for one or two posts per row; joining inside the union would
        do that work for every candidate row before the LIMIT cuts it to a page.

        Scaling, measured: SQLite materialises the compound SELECT as a co-routine and
        sorts it in a temp B-tree, so a page costs ~0.6us per row of TOTAL history
        regardless of how deep it is — 1.9ms at today's 4.4k events, ~110ms at 200k.
        Indexing the three tables does NOT help (the plan is unchanged; SQLite will not
        use an index to order a compound subquery). The fix, when it is needed, is to
        push the WHERE/ORDER BY/LIMIT into each branch and merge — measured 900x on a
        200k copy — at the price of a per-branch cursor that has to reason about where
        the branch's kind sorts against the cursor's. Not worth that complexity yet.
        """
        where, params = "", []
        if before is not None:
            where = "WHERE (created_at, kind, id) < (?, ?, ?)"
            params = list(before)
        self.cur.execute(
            f"SELECT * FROM ({_TIMELINE_SQL}) {where} "  # noqa: S608
            "ORDER BY created_at DESC, kind DESC, id DESC LIMIT ?",
            [*params, limit],
        )
        return fetch_all_dicts(self.cur)

    @in_thread
    def edit(self, *, kind: str, annotation_id: int, verdict: int | str) -> bool:
        """Correct one event's verdict in place. Returns whether a row was touched.

        In place, not appended: see migration 0014 — pairwise exports one row per
        judgement with no latest-wins pass, so an appended correction leaves the wrong
        verdict in the training set. ``edited_at`` is what marks ``elapsed_ms`` as no
        longer describing this row.
        """
        table, column = _MUTABLE[kind]
        self.cur.execute(
            f"UPDATE {table} SET {column} = ?, edited_at = datetime('now') WHERE id = ?",  # noqa: S608
            [verdict, annotation_id],
        )
        return self.cur.rowcount > 0

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
