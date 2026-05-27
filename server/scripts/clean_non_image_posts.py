"""Delete legacy non-image posts (files + DB rows).

The Danbooru import filter (``services.danbooru_import.SUPPORTED_IMAGE_EXTS``)
only started excluding non-image files (mp4 / webm / zip-ugoira / swf) on
2026-05-27. Posts pulled before that left video/ugoira files on disk and rows
in the DB. This one-shot maintenance script removes them, mirroring the same
allow-list so it can never drift from what import keeps.

Deletion matches ``PostRepo.delete_many``: FK ``ON DELETE CASCADE`` clears
``post_has_tag`` / ``post_has_color`` / ``post_*_scores`` automatically, while
``post_vectors_siglip2`` (a vec0 virtual table that ignores FK cascades) is
cleared explicitly.

Run from the server/ dir:
    uv run python scripts/clean_non_image_posts.py            # dry-run (default)
    uv run python scripts/clean_non_image_posts.py --apply    # actually delete
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import sqlite_vec

# Force UTF-8 on stdout/stderr so output doesn't crash on Windows terminals
# whose default codec (cp932 / cp936) can't encode non-ASCII. ``getattr``
# rather than ``sys.stdout.reconfigure`` directly: the static type of
# ``sys.stdout`` is ``TextIO``, which Pylance says has no ``reconfigure``.
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

# Single source of truth for "what counts as an image" — the same set the
# Danbooru importer filters on, so this cleanup can never keep something import
# would now reject (or vice versa).
from services.danbooru_import import SUPPORTED_IMAGE_EXTS

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"
DELETE_BATCH = 500


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)  # required to touch the post_vectors_siglip2 vec0 table
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")  # enforce child-row cascades
    return conn


def _find_non_image_posts(conn: sqlite3.Connection) -> list[tuple[int, str, str]]:
    allow = sorted(SUPPORTED_IMAGE_EXTS)
    placeholders = ",".join("?" * len(allow))
    cur = conn.execute(
        f"SELECT id, full_path, LOWER(extension) FROM posts WHERE LOWER(extension) NOT IN ({placeholders}) ORDER BY id",
        allow,
    )
    return [(int(r[0]), r[1], r[2]) for r in cur.fetchall()]


def _delete_db_rows(conn: sqlite3.Connection, ids: list[int]) -> None:
    for start in range(0, len(ids), DELETE_BATCH):
        chunk = ids[start : start + DELETE_BATCH]
        placeholders = ",".join("?" * len(chunk))
        # vec0 virtual table first (no FK cascade), then posts (cascades the rest).
        conn.execute(f"DELETE FROM post_vectors_siglip2 WHERE post_id IN ({placeholders})", chunk)
        conn.execute(f"DELETE FROM posts WHERE id IN ({placeholders})", chunk)
    conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite path (default: {DEFAULT_DB})")
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    args = parser.parse_args()

    target_dir = args.db.resolve().parent.parent  # <target_dir>/.pictoria/pictoria.sqlite
    print(f"DB:         {args.db}")
    print(f"target_dir: {target_dir}")
    print(f"image exts: {', '.join(sorted(SUPPORTED_IMAGE_EXTS))}")
    print(f"mode:       {'APPLY (deleting)' if args.apply else 'DRY-RUN (no changes)'}\n")

    conn = _connect(args.db)
    try:
        rows = _find_non_image_posts(conn)
        if not rows:
            print("No non-image posts found. Nothing to do.")
            return

        by_ext = Counter(ext for _, _, ext in rows)
        print(f"Found {len(rows)} non-image posts:")
        for ext, n in sorted(by_ext.items(), key=lambda kv: -kv[1]):
            print(f"  {ext:8} {n}")
        print()

        # Phase 1: files on disk.
        deleted_files = missing_files = 0
        for _, full_path, _ in rows:
            abs_path = target_dir / full_path
            if not abs_path.is_file():
                missing_files += 1
                continue
            if args.apply:
                abs_path.unlink()
            deleted_files += 1
        verb = "Deleted" if args.apply else "Would delete"
        print(f"Files:  {verb} {deleted_files} on disk ({missing_files} already missing).")

        # Phase 2: DB rows (+ cascades + vec0).
        ids = [pid for pid, _, _ in rows]
        if args.apply:
            _delete_db_rows(conn, ids)
            print(f"DB:     Deleted {len(ids)} post rows (+ cascaded tags/colors/scores, vec0 cleared).")
        else:
            print(f"DB:     Would delete {len(ids)} post rows (+ cascaded tags/colors/scores, vec0 cleared).")

        if not args.apply:
            print("\nDry-run only. Re-run with --apply to perform the deletion.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
