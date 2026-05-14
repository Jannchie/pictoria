"""One-shot ETL: copy a Pictoria DuckDB database into a fresh SQLite + sqlite-vec file.

Usage
-----
The Pictoria server holds an exclusive lock on the live DuckDB file. Two ways
to handle that:

    A) Stop the server, then run the ETL directly against the live file:
        uv run --with duckdb python scripts/migrate_duckdb_to_sqlite.py \\
            <path/to/pictoria.duckdb> <path/to/pictoria.sqlite>

    B) Take a snapshot via the server's /v2/cmd/db/snapshot endpoint and
       run the ETL against the snapshot:
        curl -XPOST http://localhost:4777/v2/cmd/db/snapshot
        uv run --with duckdb python scripts/migrate_duckdb_to_sqlite.py \\
            <path-from-snapshot-response> <path/to/pictoria.sqlite>

The destination SQLite file is created fresh — refuses to overwrite an
existing file. Run schema migrations on it first by importing
``db.migrator`` so the sqlite-vec virtual tables exist.

Notable transformations
-----------------------
- ``tag_groups``: deduped by ``name`` (DuckDB schema lacked UNIQUE; the new
  schema adds it). Duplicate-name groups are merged into the lowest-id row,
  and references in ``tags.group_id`` are remapped accordingly.
- ``posts.dominant_color``: DuckDB stored ``FLOAT[3]`` as a Python list,
  SQLite stores a sqlite-vec serialized FLOAT[3] BLOB. Conversion happens
  per row.
- ``post_vectors.embedding``: moved from a regular DuckDB table to the
  sqlite-vec ``vec0`` virtual table; FLOAT[768] list → BLOB.
- Timestamps: DuckDB returns Python ``datetime`` objects; SQLite stores the
  ISO 8601 string form. ``str(dt)`` round-trips correctly with Pydantic.
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

# Line-buffer stdout/stderr so progress prints land in the log file
# immediately even when the process is backgrounded (otherwise a long fetch
# can sit silently for minutes, then a crash drops the entire buffer).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True, errors="replace")

# `--with duckdb` keeps duckdb out of the project's runtime dependencies.
import duckdb  # type: ignore[import-not-found]
import sqlite_vec

# Make repo imports resolve when invoked from `server/`.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "src"))

# Avoid pulling shared.target_dir initialization — entities.py only references
# shared at attribute access time on the convenience properties.
import shared

shared.target_dir = Path()
shared.thumbnails_dir = Path()
shared.pictoria_dir = Path()

from db.connection import DB
from db.migrator import run_migrations


def _format_ts(value):
    """DuckDB datetime → ISO 8601 string SQLite expects."""
    if value is None:
        return None
    return value.isoformat(sep=" ")


def _serialize_vector(value, expected_dim: int | None = None) -> bytes | None:
    """Convert DuckDB list[float] (or numpy array) → sqlite-vec BLOB."""
    if value is None:
        return None
    if hasattr(value, "tolist"):
        value = value.tolist()
    if expected_dim is not None and len(value) != expected_dim:
        msg = f"Vector dim mismatch: expected {expected_dim}, got {len(value)}"
        raise ValueError(msg)
    return sqlite_vec.serialize_float32([float(x) for x in value])


def _stream(cur, fetch_size: int = 5000):
    """Yield rows from a DuckDB cursor in chunks (streaming, never fetchall).

    `fetchall()` materializes the entire result set in memory; for the
    multi-million-row tables (post_has_tag) that's hundreds of MB of Python
    tuples and easily OOMs the process.
    """
    while True:
        rows = cur.fetchmany(fetch_size)
        if not rows:
            break
        yield from rows


def _migrate_tag_groups(src: duckdb.DuckDBPyConnection, dst, *, log) -> dict[int, int]:
    """Copy tag_groups, dedup by name, return old_id -> new_id map."""
    src.execute(
        "SELECT id, name, parent_id, color, created_at, updated_at FROM tag_groups ORDER BY id",
    )
    rows = src.fetchall()
    log(f"  read {len(rows)} tag_groups rows")

    # Pick the smallest old_id for each name to act as the canonical row.
    canonical_old_id_by_name: dict[str, int] = {}
    for old_id, name, _parent_id, _color, _ca, _ua in rows:
        canonical_old_id_by_name.setdefault(name, old_id)

    # Insert canonical rows; remember their new_id (autoincrement-assigned).
    old_to_new: dict[int, int] = {}
    name_to_new: dict[str, int] = {}
    inserted = 0
    for old_id, name, parent_id, color, ca, ua in rows:
        if canonical_old_id_by_name[name] != old_id:
            continue  # duplicate, will remap below
        cur = dst.execute(
            """
            INSERT INTO tag_groups(name, parent_id, color, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id
            """,
            [name, parent_id, color, _format_ts(ca), _format_ts(ua)],
        )
        new_id = cur.fetchone()[0]
        old_to_new[old_id] = new_id
        name_to_new[name] = new_id
        inserted += 1

    # Map duplicate-name old_ids to the canonical new_id.
    for old_id, name, *_rest in rows:
        if old_id not in old_to_new:
            old_to_new[old_id] = name_to_new[name]

    log(f"  inserted {inserted} canonical tag_groups (deduped from {len(rows)})")
    return old_to_new


def _migrate_tags(src: duckdb.DuckDBPyConnection, dst, group_id_map: dict[int, int], *, log) -> None:
    src.execute("SELECT name, group_id, created_at, updated_at FROM tags")
    sql = "INSERT INTO tags(name, group_id, created_at, updated_at) VALUES (?, ?, ?, ?)"
    batch: list[tuple] = []
    total = 0
    for name, group_id, ca, ua in _stream(src):
        new_gid = group_id_map.get(group_id) if group_id is not None else None
        batch.append((name, new_gid, _format_ts(ca), _format_ts(ua)))
        if len(batch) >= 5000:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} tags")


def _migrate_posts(src: duckdb.DuckDBPyConnection, dst, *, log) -> None:
    src.execute(
        """
        SELECT
            id, file_path, file_name, extension, width, height,
            published_at, score, rating, description, meta, sha256, size,
            source, caption, dominant_color, thumbhash, created_at, updated_at
        FROM posts
        ORDER BY id
        """,
    )
    batch: list[tuple] = []
    total = 0
    sql = """
        INSERT INTO posts(
            id, file_path, file_name, extension, width, height,
            published_at, score, rating, description, meta, sha256, size,
            source, caption, dominant_color, thumbhash, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    for row in _stream(src, fetch_size=1000):
        (
            pid, fp, fn, ext, w, h, pub_at, score, rating, desc, meta, sha,
            size, src_url, cap, dom, th, ca, ua,
        ) = row
        batch.append(
            (
                pid, fp, fn, ext, w, h,
                _format_ts(pub_at), score, rating, desc, meta, sha, size,
                src_url, cap,
                _serialize_vector(dom, expected_dim=3),
                th,
                _format_ts(ca), _format_ts(ua),
            ),
        )
        if len(batch) >= 1000:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
            if total % 10000 == 0:
                log(f"    posts: {total}")
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} posts")


def _migrate_post_has_tag(src: duckdb.DuckDBPyConnection, dst, *, log) -> None:
    src.execute("SELECT post_id, tag_name, is_auto FROM post_has_tag")
    batch: list[tuple] = []
    total = 0
    sql = "INSERT OR IGNORE INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?)"
    for post_id, tag_name, is_auto in _stream(src, fetch_size=10000):
        batch.append((post_id, tag_name, 1 if is_auto else 0))
        if len(batch) >= 10000:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
            if total % 100000 == 0:
                log(f"    post_has_tag: {total}")
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} post_has_tag")


def _migrate_post_has_color(src: duckdb.DuckDBPyConnection, dst, *, log) -> None:
    src.execute('SELECT post_id, "order", color FROM post_has_color')
    batch: list[tuple] = []
    total = 0
    sql = 'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)'
    for post_id, order, color in _stream(src, fetch_size=10000):
        batch.append((post_id, order, color))
        if len(batch) >= 10000:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} post_has_color")


def _migrate_post_waifu_scores(src: duckdb.DuckDBPyConnection, dst, *, log) -> None:
    src.execute("SELECT post_id, score FROM post_waifu_scores")
    batch: list[tuple] = []
    total = 0
    sql = "INSERT INTO post_waifu_scores(post_id, score) VALUES (?, ?)"
    for post_id, score in _stream(src, fetch_size=10000):
        batch.append((post_id, score))
        if len(batch) >= 10000:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} post_waifu_scores")


def _migrate_post_vectors(src: duckdb.DuckDBPyConnection, dst, *, log) -> None:
    src.execute("SELECT post_id, embedding FROM post_vectors ORDER BY post_id")
    batch: list[tuple] = []
    total = 0
    # vec0 doesn't accept executemany cleanly across all sqlite-vec versions
    # for the virtual-table form, but per-row is fast enough at this scale.
    sql = "INSERT INTO post_vectors(post_id, embedding) VALUES (?, ?)"
    for post_id, embedding in _stream(src, fetch_size=500):
        blob = _serialize_vector(embedding, expected_dim=768)
        batch.append((post_id, blob))
        if len(batch) >= 500:
            dst.executemany(sql, batch)
            total += len(batch)
            batch.clear()
            if total % 5000 == 0:
                log(f"    post_vectors: {total}")
    if batch:
        dst.executemany(sql, batch)
        total += len(batch)
    log(f"  inserted {total} post_vectors")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="Path to existing pictoria.duckdb")
    parser.add_argument("dest", type=Path, help="Path to write new pictoria.sqlite (must not exist)")
    parser.add_argument(
        "--migrations-dir",
        type=Path,
        default=_HERE.parent / "migrations",
        help="Migrations directory (default: server/migrations/)",
    )
    parser.add_argument(
        "--allow-overwrite",
        action="store_true",
        help="Delete the destination file first if it exists",
    )
    args = parser.parse_args()

    if not args.source.exists():
        print(f"ERROR: source not found: {args.source}")
        return 1
    if args.dest.exists():
        if args.allow_overwrite:
            args.dest.unlink()
            print(f"Removed existing destination: {args.dest}")
        else:
            print(f"ERROR: destination already exists: {args.dest} (use --allow-overwrite)")
            return 1

    print(f"Source DuckDB:    {args.source}  ({args.source.stat().st_size / 1e6:.1f} MB)")
    print(f"Destination SQLite: {args.dest}")
    print()

    src = duckdb.connect(str(args.source), read_only=True)
    dst_db = DB(args.dest)
    dst = dst_db.cursor()

    print("Applying migrations to destination ...")
    n = run_migrations(dst, args.migrations_dir)
    print(f"  {n} migration(s) applied")

    def log(msg: str) -> None:
        print(msg)

    t0 = time.monotonic()

    # tag_groups must come before tags (FK).
    print("\nMigrating tag_groups ...")
    group_map = _migrate_tag_groups(src, dst, log=log)

    print("\nMigrating tags ...")
    _migrate_tags(src, dst, group_map, log=log)

    print("\nMigrating posts ...")
    _migrate_posts(src, dst, log=log)

    print("\nMigrating post_has_tag ...")
    _migrate_post_has_tag(src, dst, log=log)

    print("\nMigrating post_has_color ...")
    _migrate_post_has_color(src, dst, log=log)

    print("\nMigrating post_waifu_scores ...")
    _migrate_post_waifu_scores(src, dst, log=log)

    print("\nMigrating post_vectors (this is the slow one) ...")
    _migrate_post_vectors(src, dst, log=log)

    elapsed = time.monotonic() - t0

    print(f"\nDone in {elapsed:.1f}s. New DB: {args.dest} ({args.dest.stat().st_size / 1e6:.1f} MB)")
    src.close()
    dst.close()
    dst_db.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Without this, an exception during a long fetch buffers traceback
        # to stderr and (in background runs) can be lost on process exit.
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        sys.exit(2)
