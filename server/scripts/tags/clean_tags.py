"""Remove tags whose name contains a literal `%` character (legacy junk).

Run from server/ dir:
    uv run python scripts/tags/clean_tags.py [path/to/pictoria.duckdb]

Defaults to ``illustration/images/.pictoria/pictoria.duckdb`` if no path is
given. Also wipes the matching rows from ``post_has_tag`` first, since
DuckDB does not enforce the logical FK.
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb

DEFAULT_DB = (
    Path(__file__).resolve().parents[2]
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
    pattern = r"%\%%"  # LIKE pattern: any name containing a literal '%'

    before = conn.execute(
        "SELECT count(*) FROM tags WHERE name LIKE ? ESCAPE '\\'",
        [pattern],
    ).fetchone()[0]
    print(f"tags matching '%\\%%': {before}")

    conn.execute(
        "DELETE FROM post_has_tag WHERE tag_name LIKE ? ESCAPE '\\'",
        [pattern],
    )
    conn.execute(
        "DELETE FROM tags WHERE name LIKE ? ESCAPE '\\'",
        [pattern],
    )
    print(f"deleted {before} tags (and their post_has_tag rows)")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
