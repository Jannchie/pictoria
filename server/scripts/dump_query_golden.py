"""Re-dump the query-parity golden fixture from the Python side.

    cd server && uv run python scripts/dump_query_golden.py

``packages/db/src/query-parity.test.ts`` pins ``buildWhere``'s *results* — counts
and the first 20 ids — against the live library, which is what catches parameter
binding order and LEFT JOIN semantics drifting between the two implementations
in ways the SQL-text comparison can't see.

Being pinned to a live library means the fixture goes stale whenever the library
changes (an import, a delete). That is not a failure of the test; it just needs
regenerating, and this script is how — from Python, because Python being the
reference is the entire point. Regenerating it from the TS side would turn the
test into a tautology.

Filter cases live here, not in the TS test, for the same reason.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import sqlite_vec

from db.filters import PostFilter, build_where

SERVER_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"
OUT = SERVER_ROOT.parent / "packages" / "db" / "src" / "__fixtures__" / "counts-golden.json"

CASES: list[tuple[str, dict[str, Any]]] = [
    ("empty", {}),
    ("only_canonical_false", {"only_canonical": False}),
    ("rating", {"rating": [1, 2]}),
    ("score", {"score": [4, 5]}),
    ("single_tag", {"tags": ["1girl"]}),
    ("multi_tag_and", {"tags": ["1girl", "solo"]}),
    ("extension", {"extension": ["jpg"]}),
    ("folder", {"folder": "danbooru"}),
    ("waifu_range", {"waifu_score_range": [6.0, 10.0]}),
    ("waifu_levels", {"waifu_score_levels": ["A", "B"]}),
    ("waifu_unscored", {"waifu_score_levels": ["UNSCORED"]}),
    ("silva_levels", {"silva_score_levels": ["A"]}),
    ("both_silva", {"silva_score_levels": ["A"], "silva_luna_score_levels": ["A"]}),
    (
        "kitchen_sink",
        {
            "rating": [1, 2],
            "score": [3, 4, 5],
            "extension": ["jpg", "png"],
            "waifu_score_levels": ["A", "B"],
        },
    ),
]


def main() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    cur = conn.cursor()

    out = []
    for name, raw in CASES:
        where_clauses, params, joins = build_where(PostFilter(**raw))
        joins_sql = "\n".join(joins)
        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        cur.execute(f"SELECT COUNT(*) FROM posts p {joins_sql} {where_sql}", params)
        count = cur.fetchone()[0]
        cur.execute(f"SELECT p.id FROM posts p {joins_sql} {where_sql} ORDER BY p.id LIMIT 20", params)
        out.append(
            {
                "name": name,
                "filter": raw,
                "count": count,
                "first_ids": [r[0] for r in cur.fetchall()],
            },
        )

    conn.close()
    OUT.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    sys.stderr.write(f"wrote {len(out)} cases to {OUT}\n")


if __name__ == "__main__":
    main()
