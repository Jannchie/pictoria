"""One-shot import of the ``Jannchie/danbooru2026-silva-aesthetic`` local mirror.

The dataset is SILVA applied to all of danbooru2026; its local mirror holds, per
shard, the images scoring ``>= 0.80`` (``images/XXXX/<post_id>.webp``) and a
parquet of scores (``scores/data-XXXX.parquet``). Tags, rating, source and
upload date come from the Danbooru metadata archive (``danbooru_metadata.db``),
looked up by post id. This script walks every shard the mirror has, copies the
images into ``<library>/danbooru2026/<shard>/``, writes the posts with their
tags, and writes the SILVA score straight into ``post_aesthetic_scores`` —
same model as the library's ``silva`` scorer, so re-scoring on the GPU would
only reproduce the parquet.

It is a maintenance script, not an endpoint: it runs once per mirror refresh
and never from the UI, so it sits next to ``clean_truncated_images.py`` and
opens ``pictoria.sqlite`` directly — the same way every script in this
directory does. The write shape is a transcript of ``persistPostsWithTags``
(``packages/db/src/repositories/import-persist.ts``): tags in one short
transaction, then posts + links per shard, so a concurrent importer's tag
collision only replays the small part. Copy precedes persist on purpose — a
row must never exist before its file, or the API's sync reconciler deletes it
mid-copy. Temp files are ``*.part``, which the reconciler already skips.

Re-runnable: a post already imported with a manual tag is skipped, so after
``sync.py`` pulls more shards, running this again picks up only the new ones.

Run from the server/ dir:
    uv run python scripts/import_silva_dataset.py --dataset-dir F:/mirror --metadata-db E:/meta.db
    uv run python scripts/import_silva_dataset.py ... --shards 0000-0009 --dry-run
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path

# Force UTF-8 on stdout/stderr so output doesn't crash on Windows terminals
# whose default codec (cp932 / cp936) can't encode non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from paths import db_path, target_dir
from services.silva_dataset_import import ShardJob, import_shard

#: Top-level library directory for this dataset; the shard is the subdirectory.
LIBRARY_DIR_NAME = "danbooru2026"

#: ``scorer`` value in ``post_aesthetic_scores`` — the ``ScorerSpec`` name.
SILVA_SCORER = "silva"

#: The five canonical tag groups **in priority order**, and their badge colours.
#: A transcript of ``CANONICAL_TAG_GROUPS`` / ``TAG_GROUP_COLORS`` in
#: ``packages/db/src/repositories/backfill.ts`` — a tag under two types keeps
#: the first group here, so the order is load-bearing.
CANONICAL_TAG_GROUPS: dict[str, str] = {
    "artist": "#f30000",
    "character": "#8243ca",
    "copyright": "#00b300",
    "general": "#006192",
    "meta": "#000000",
}

_SHARD_RE = re.compile(r"^data-(\d{4})\.parquet$")


def connect(path: Path) -> sqlite3.Connection:
    # A long timeout: the API process commits backfill batches every few
    # seconds, and losing an hour of copying to one 5 s lock wait is silly.
    conn = sqlite3.connect(str(path), timeout=60.0)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def list_shards(dataset_dir: Path) -> list[str]:
    """Shards the mirror has, by ``scores/data-XXXX.parquet``.

    The parquet rather than ``images/``: ``sync.py`` only copies a parquet after
    its tar is extracted, so a parquet's presence means the shard is complete.
    """
    scores = dataset_dir / "scores"
    if not scores.is_dir():
        return []
    return sorted(m.group(1) for p in scores.iterdir() if (m := _SHARD_RE.match(p.name)))


def parse_shard_range(spec: str | None, available: list[str]) -> list[str]:
    """``0000-0009`` / ``0003`` / ``0001,0005`` → the subset of ``available``."""
    if not spec:
        return available
    wanted: set[str] = set()
    for raw in spec.split(","):
        part = raw.strip()
        if "-" in part:
            lo, hi = part.split("-", 1)
            wanted.update(f"{i:04d}" for i in range(int(lo), int(hi) + 1))
        elif part:
            wanted.add(f"{int(part):04d}")
    return [s for s in available if s in wanted]


def ensure_canonical_tag_groups(conn: sqlite3.Connection) -> dict[str, int]:
    """Same as TS ``ensureCanonicalTagGroups``: create-if-missing, return ``{name: id}``."""
    out: dict[str, int] = {}
    with conn:
        for name, color in CANONICAL_TAG_GROUPS.items():
            conn.execute("INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING", (name, color))
            out[name] = conn.execute("SELECT id FROM tag_groups WHERE name = ?", (name,)).fetchone()[0]
    return out


def imported_ids(conn: sqlite3.Connection, file_path: str) -> set[str]:
    """Post ids under ``file_path`` that already carry a manual tag.

    Same rule as TS ``listImportedDanbooruIds``: "has a manual tag", not "row
    exists" — the sync reconciler inserts bare rows for files it finds on disk,
    and those must still get their tags on the next run.
    """
    rows = conn.execute(
        "SELECT p.file_name FROM posts p JOIN post_has_tag pht ON pht.post_id = p.id AND pht.is_auto = 0 WHERE p.file_path = ?",
        (file_path,),
    )
    return {r[0] for r in rows}


def library_danbooru_ids(conn: sqlite3.Connection) -> set[str]:
    """Danbooru post ids the library already holds, from any directory but ours.

    The tag importer files every post as ``danbooru/<tag>/<post_id>.<ext>``, so
    ``file_name`` under ``danbooru/`` *is* the post id — the same equivalence
    ``listImportedDanbooruIds`` leans on. Measured before this was written: of
    the first 50k mirror ids, 7.5% were already in the library this way, and
    matching on ``source`` URL on top found nothing more.
    """
    rows = conn.execute("SELECT file_name FROM posts WHERE file_path LIKE 'danbooru/%'")
    return {r[0] for r in rows}


def persist_rows(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Tags, then posts + links + scores. Returns the number of scores written.

    Two transactions, as in ``persistPostsWithTags``. The post upsert also
    refreshes ``rating`` on conflict (TS leaves it alone): the only conflict
    this script can hit is a bare row the reconciler created while the copy
    was in flight, and that row has no rating worth keeping.
    """
    if not rows:
        return 0
    all_tags: dict[str, int] = {}
    for row in rows:
        for name, gid in row["tags"].items():
            all_tags.setdefault(name, gid)
    with conn:
        conn.executemany(
            "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
            list(all_tags.items()),
        )

    scored = 0
    with conn:
        for row in rows:
            post_id = conn.execute(
                "INSERT INTO posts(file_path, file_name, extension, source, rating, published_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (file_path, file_name, extension) "
                "DO UPDATE SET source = excluded.source, rating = excluded.rating, "
                "published_at = excluded.published_at, updated_at = CURRENT_TIMESTAMP "
                "RETURNING id",
                (row["filePath"], row["fileName"], row["extension"], row["source"], row["rating"], row["publishedAt"]),
            ).fetchone()[0]
            conn.executemany(
                "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
                [(post_id, name) for name in row["tags"]],
            )
            if row["silvaScore"] is not None:
                conn.execute(
                    "INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (?, ?, ?) "
                    "ON CONFLICT (post_id, scorer) DO UPDATE SET score = excluded.score",
                    (post_id, SILVA_SCORER, row["silvaScore"]),
                )
                scored += 1
    return scored


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset-dir", type=Path, required=True, help="local mirror root (has scores/ and images/)")
    ap.add_argument("--metadata-db", type=Path, required=True, help="danbooru_metadata.db (read-only)")
    ap.add_argument("--db", type=Path, default=None, help=f"pictoria.sqlite (default: {db_path()})")
    ap.add_argument("--library", type=Path, default=None, help=f"image library root (default: {target_dir()})")
    ap.add_argument("--shards", default=None, help="subset, e.g. 0000-0009 or 0003,0007 (default: all in the mirror)")
    ap.add_argument("--dry-run", action="store_true", help="list what would be imported; copy nothing, write nothing")
    ap.add_argument(
        "--no-dedup",
        action="store_true",
        help="import posts even when the library already has them under danbooru/<tag>/",
    )
    args = ap.parse_args()

    dataset_dir: Path = args.dataset_dir.resolve()
    metadata_db: Path = args.metadata_db.resolve()
    library: Path = (args.library or target_dir()).resolve()
    database: Path = (args.db or db_path()).resolve()
    if not metadata_db.is_file():
        print(f"metadata db not found: {metadata_db}", file=sys.stderr)
        return 2
    shards = parse_shard_range(args.shards, list_shards(dataset_dir))
    if not shards:
        print(f"no scores/data-XXXX.parquet under {dataset_dir}", file=sys.stderr)
        return 2

    print(f"mirror   : {dataset_dir}  ({len(shards)} shards)")
    print(f"metadata : {metadata_db}")
    print(f"library  : {library / LIBRARY_DIR_NAME}")
    print(f"database : {database}{'  (dry run)' if args.dry_run else ''}")

    conn = connect(database)
    type_to_group_id = ensure_canonical_tag_groups(conn)
    duplicate_ids = set() if args.no_dedup else library_danbooru_ids(conn)
    print(f"dedup    : {len(duplicate_ids)} danbooru ids already in the library{'  (off)' if args.no_dedup else ''}")

    totals = {
        "onDisk": 0,
        "skipped": 0,
        "duplicates": 0,
        "missingMeta": 0,
        "missingScore": 0,
        "copied": 0,
        "rows": 0,
        "scores": 0,
    }
    t0 = time.time()
    for i, shard in enumerate(shards, 1):
        file_path = f"{LIBRARY_DIR_NAME}/{shard}"
        job = ShardJob(
            parquet_path=dataset_dir / "scores" / f"data-{shard}.parquet",
            images_dir=dataset_dir / "images" / shard,
            metadata_db=metadata_db,
            save_dir=library / LIBRARY_DIR_NAME / shard,
            file_path_str=file_path,
            existing_ids=imported_ids(conn, file_path),
            type_to_group_id=type_to_group_id,
            duplicate_ids=duplicate_ids,
            dry_run=args.dry_run,
        )
        result = import_shard(job)
        scores = 0 if args.dry_run else persist_rows(conn, result.rows)
        st = result.stats
        for k in ("onDisk", "skipped", "duplicates", "missingMeta", "missingScore", "copied", "rows"):
            totals[k] += st[k]
        totals["scores"] += scores
        elapsed = time.time() - t0
        eta = elapsed / i * (len(shards) - i)
        print(
            f"[{i}/{len(shards)}] {shard}: disk {st['onDisk']:>4}  new {st['rows']:>4}  copied {st['copied']:>4}"
            f"  dup {st['duplicates']:>4}  skip {st['skipped']:>4}  no-meta {st['missingMeta']:>3}  no-score {st['missingScore']:>3}"
            f"  ({elapsed:.0f}s, eta {eta:.0f}s)",
            flush=True,
        )
    conn.close()

    print(
        f"\ndone in {time.time() - t0:.0f}s: on disk {totals['onDisk']}, imported {totals['rows']} "
        f"(copied {totals['copied']}, scores {totals['scores']}), duplicates {totals['duplicates']}, "
        f"skipped {totals['skipped']}, no metadata {totals['missingMeta']}, no score {totals['missingScore']}",
    )
    if not args.dry_run and totals["rows"]:
        print("the API's backfill will pick up embeddings / silva_luna / tags for the new posts on its next scan.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
