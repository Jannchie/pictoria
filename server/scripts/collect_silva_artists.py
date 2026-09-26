"""Add every artist in the ``danbooru2026-silva-aesthetic`` mirror to ``scripts/tags.txt``.

The mirror's ``images/XXXX/<post_id>.webp`` is the curated slice (SILVA
``>= 0.80``); each post's ``tag_string_artist`` comes from the Danbooru metadata
archive, looked up by id — the same lookup ``import_silva_dataset.py`` uses.
New artists are appended to the tag pool that ``run_get_artist_data.py`` walks;
the lines already there keep their order and are never removed, so the pool can
still carry hand-picked artists the mirror does not have. Re-runnable: after
``sync.py`` pulls more shards, running this again appends only the new names.

``--rated-min 5`` narrows that to the artists you have given at least one
5-star post in the library — a way to grow the pool in slices rather than all
at once.

Placeholder artist tags (``unknown_artist`` and friends) are left out: they
name no one, and pulling one from Danbooru would drag in hundreds of thousands
of unrelated posts.

Run from the server/ dir:
    uv run python scripts/collect_silva_artists.py --dataset-dir F:/mirror --metadata-db E:/meta.db
    uv run python scripts/collect_silva_artists.py ... --min-posts 3 --dry-run
    uv run python scripts/collect_silva_artists.py ... --rated-min 5
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

# Force UTF-8 on stdout/stderr so output doesn't crash on Windows terminals
# whose default codec (cp932 / cp936) can't encode non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from paths import db_path
from services.silva_dataset_import import list_shard_images, lookup_metadata

DEFAULT_TAGS_FILE = SERVER_ROOT.parent / "scripts" / "tags.txt"

#: Artist-typed Danbooru tags that stand for "no identifiable artist".
PLACEHOLDER_ARTISTS: frozenset[str] = frozenset(
    {"anonymous_artist", "unknown_artist", "banned_artist", "artist_request", "third-party_edit"},
)


def count_artists(dataset_dir: Path, metadata_db: Path) -> tuple[Counter[str], int, int]:
    """``(posts per artist, images on disk, images without metadata)`` over every shard."""
    counts: Counter[str] = Counter()
    on_disk = missing = 0
    shard_dirs = sorted(p for p in (dataset_dir / "images").iterdir() if p.is_dir())
    for i, shard_dir in enumerate(shard_dirs, 1):
        ids = list(list_shard_images(shard_dir))
        meta = lookup_metadata(metadata_db, ids)
        on_disk += len(ids)
        missing += len(ids) - len(meta)
        for row in meta.values():
            counts.update(set(row.tag_strings.get("artist", "").split()) - PLACEHOLDER_ARTISTS)
        if i % 50 == 0 or i == len(shard_dirs):
            print(f"[{i}/{len(shard_dirs)}] {on_disk} images, {len(counts)} artists", flush=True)
    return counts, on_disk, missing


def rated_artists(database: Path, min_score: int) -> set[str]:
    """Artist tags on at least one library post you scored ``>= min_score``.

    ``CROSS JOIN`` pins the join order: left to the planner, it walks every
    artist tag and probes posts for each, which takes minutes instead of seconds.
    """
    con = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    try:
        rows = con.execute(
            """
            SELECT DISTINCT pht.tag_name
            FROM posts p
            CROSS JOIN post_has_tag pht ON pht.post_id = p.id
            CROSS JOIN tags t ON t.name = pht.tag_name
            CROSS JOIN tag_groups g ON g.id = t.group_id
            WHERE p.score >= ? AND g.name = 'artist'
            """,
            (min_score,),
        )
        return {name for (name,) in rows}
    finally:
        con.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset-dir", type=Path, required=True, help="local mirror root (has images/)")
    ap.add_argument("--metadata-db", type=Path, required=True, help="danbooru_metadata.db (read-only)")
    ap.add_argument("--tags-file", type=Path, default=DEFAULT_TAGS_FILE, help=f"tag pool (default: {DEFAULT_TAGS_FILE})")
    ap.add_argument("--min-posts", type=int, default=1, help="only artists with at least N images in the mirror (default 1)")
    ap.add_argument(
        "--rated-min",
        type=int,
        default=None,
        metavar="STARS",
        help="only artists with at least one library post you scored >= STARS (default: no filter)",
    )
    ap.add_argument("--db", type=Path, default=None, help=f"pictoria.sqlite, for --rated-min (default: {db_path()})")
    ap.add_argument("--dry-run", action="store_true", help="report what would be appended; write nothing")
    args = ap.parse_args()

    if not args.metadata_db.is_file():
        print(f"metadata db not found: {args.metadata_db}", file=sys.stderr)
        return 2
    if not (args.dataset_dir / "images").is_dir():
        print(f"no images/ under {args.dataset_dir}", file=sys.stderr)
        return 2

    counts, on_disk, missing = count_artists(args.dataset_dir, args.metadata_db)
    if args.rated_min is not None:
        rated = rated_artists(args.db or db_path(), args.rated_min)
        counts = Counter({name: n for name, n in counts.items() if name in rated})
        print(f"--rated-min {args.rated_min}: {len(rated)} rated artists in the library, {len(counts)} of them in the mirror")
    existing_text = args.tags_file.read_text(encoding="utf-8") if args.tags_file.exists() else ""
    existing = {line.strip() for line in existing_text.splitlines() if line.strip()}
    # Most-represented first, so a partial run of the downloader covers the
    # artists that matter most; name breaks ties for a stable file.
    new = [name for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])) if n >= args.min_posts and name not in existing]

    eligible = sum(1 for n in counts.values() if n >= args.min_posts)
    print(
        f"\n{on_disk} images ({missing} without metadata), {len(counts)} artists, "
        f"{eligible} with >= {args.min_posts} posts; {eligible - len(new)} already in the pool, {len(new)} new",
    )
    if not new:
        return 0
    if args.dry_run:
        for name in new[:20]:
            print(f"  + {name} ({counts[name]})")
        if len(new) > 20:
            print(f"  ... and {len(new) - 20} more")
        return 0

    sep = "" if not existing_text or existing_text.endswith("\n") else "\n"
    with args.tags_file.open("a", encoding="utf-8", newline="\n") as f:
        f.write(sep + "\n".join(new) + "\n")
    print(f"appended {len(new)} artists to {args.tags_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
