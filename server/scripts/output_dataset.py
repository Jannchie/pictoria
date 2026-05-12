"""Walk all posts and emit their canonical tag list (sorted by group + name,
with artist/character/copyright/period/rating/score prefixes).

Used as the human-readable dataset preview. Run from server/ dir:

    uv run python scripts/output_dataset.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import duckdb
from rich import get_console

from progress import get_progress

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.duckdb"

GROUP_ORDER = {"artist": 0, "character": 1, "copyright": 2, "other": 3}
PREFIX_GROUPS = {"artist", "character", "copyright"}

RATING_MAP = {1: "rating:general", 2: "rating:sensitive", 3: "rating:questionable", 4: "rating:explicit"}
SCORE_MAP = {1: "score:5", 2: "score:6", 3: "score:7", 4: "score:8", 5: "score:9"}


def _period_tag(year: int | None) -> str | None:
    if year is None:
        return None
    if year < 2011:
        return "period:old"
    if year < 2014:
        return "period:early"
    if year < 2018:
        return "period:mid"
    if year < 2021:
        return "period:recent"
    return "period:newest"


def _decorate(post: dict[str, Any]) -> list[str]:
    raw = post["tags"] or []
    pairs = [(t.get("name"), t.get("group")) for t in raw if t.get("name")]
    pairs.sort(key=lambda p: (GROUP_ORDER.get(p[1] or "other", 3), p[0]))
    tags: list[str] = []
    for name, group in pairs:
        tags.append(f"{group}:{name}" if group in PREFIX_GROUPS else name)
    if (rt := RATING_MAP.get(post["rating"])):
        tags.insert(0, rt)
    if (st := SCORE_MAP.get(post["score"])):
        tags.insert(0, st)
    year = post["published_at"].year if post["published_at"] else None
    if (pt := _period_tag(year)):
        tags.insert(0, pt)
    return tags


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.exists():
        print(f"ERROR: DB not found at {db_path}")
        return 1

    console = get_console()
    conn = duckdb.connect(str(db_path), read_only=True)
    total = conn.execute("SELECT count(*) FROM posts").fetchone()[0]

    # Stream rows; one correlated LIST aggregation per post.
    conn.execute(
        """
        SELECT
            p.id,
            p.published_at,
            p.rating,
            p.score,
            COALESCE((
                SELECT list({name: t.name, group: tg.name})
                FROM post_has_tag pht
                JOIN tags t ON t.name = pht.tag_name
                LEFT JOIN tag_groups tg ON tg.id = t.group_id
                WHERE pht.post_id = p.id
            ), []) AS tags
        FROM posts p
        ORDER BY p.id
        """,
    )

    progress = get_progress(console)
    with progress:
        task = progress.add_task("Outputting dataset...", total=total)
        while chunk := conn.fetchmany(500):
            for pid, published_at, rating, score, tag_list in chunk:
                tags = _decorate({
                    "tags": tag_list,
                    "published_at": published_at,
                    "rating": rating,
                    "score": score,
                })
                console.log(tags)
                progress.update(task, advance=1)

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
