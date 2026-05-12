"""Backfill ``posts.score`` from ``post_waifu_scores.score`` for unscored posts.

Mapping:
    waifu_score in (0, 2)    -> score = 1
    waifu_score in [2, 4)    -> score = 2
    waifu_score in [4, 7.5)  -> score = 3
    waifu_score in [7.5, 8)  -> score = 4
    waifu_score >= 8         -> score = 5

Only rows where ``posts.score = 0`` and ``post_waifu_scores.score != 0`` are
touched. Run from server/ dir:

    uv run python scripts/apply_score_by_waifu_scorer.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb

DEFAULT_DB = (
    Path(__file__).resolve().parent.parent
    / "illustration"
    / "images"
    / ".pictoria"
    / "pictoria.duckdb"
)


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.exists():
        print(f"ERROR: DB not found at {db_path}")
        return 1

    conn = duckdb.connect(str(db_path))
    eligible = conn.execute(
        """
        SELECT count(*) FROM posts p
        JOIN post_waifu_scores pws ON pws.post_id = p.id
        WHERE p.score = 0 AND pws.score != 0
        """,
    ).fetchone()[0]
    print(f"eligible posts: {eligible}")

    conn.execute(
        """
        UPDATE posts AS p
        SET score = CASE
            WHEN pws.score < 2   THEN 1
            WHEN pws.score < 4   THEN 2
            WHEN pws.score < 7.5 THEN 3
            WHEN pws.score < 8   THEN 4
            ELSE 5
        END,
        updated_at = now()
        FROM post_waifu_scores pws
        WHERE p.id = pws.post_id
          AND p.score = 0
          AND pws.score != 0
        """,
    )
    print("done")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
