"""Detect and delete truncated/corrupt image posts (files + DB rows).

Flaky downloads (kemono mirrors in particular) leave partially-written files
on disk: the top of the image decodes, the bottom is missing. The server
never notices because ``shared.py`` sets ``ImageFile.LOAD_TRUNCATED_IMAGES =
True`` globally — thumbnails, scores and embeddings all get produced from the
partial pixels. This script re-checks every post with PIL in *strict* mode
(``LOAD_TRUNCATED_IMAGES = False``, the library default), where any file with
missing/garbled image data raises on full decode. Images that decode cleanly
are never flagged, so genuinely transparent art is safe.

Deletion mirrors ``PostRepo.delete_many``: FK ``ON DELETE CASCADE`` clears
``post_has_tag`` / ``post_has_color`` / ``post_*_scores`` automatically, while
``post_vectors_siglip2`` (a vec0 virtual table that ignores FK cascades) is
cleared explicitly. Both the original file and its thumbnail are unlinked.

Run from the server/ dir:
    uv run python scripts/clean_truncated_images.py            # dry-run (default)
    uv run python scripts/clean_truncated_images.py --apply    # actually delete

A dry-run writes the full hit list to ``truncated_posts.txt`` (one
``id<TAB>error<TAB>path`` per line) for manual spot-checking.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import sqlite_vec

# Force UTF-8 on stdout/stderr so output doesn't crash on Windows terminals
# whose default codec (cp932 / cp936) can't encode non-ASCII.
for _stream in (sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, "reconfigure", None)
    if _reconfigure is not None:
        _reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import pillow_avif  # noqa: F401  — registers the AVIF decoder; without it every .avif would be flagged
from PIL import Image, ImageFile

# Strict mode is the whole point of this script: a truncated file must raise
# on load() instead of silently zero-filling the missing rows. This is PIL's
# default, but the app flips it globally — make sure we run with it off.
ImageFile.LOAD_TRUNCATED_IMAGES = False
# Large-but-valid images are not corruption; don't let the decompression-bomb
# guard masquerade as a decode failure.
Image.MAX_IMAGE_PIXELS = None

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"
DEFAULT_REPORT = Path("truncated_posts.txt")
DELETE_BATCH = 500
PROGRESS_EVERY = 10_000


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)  # required to touch the post_vectors_siglip2 vec0 table
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")  # enforce child-row cascades
    return conn


def _check_one(abs_path: Path) -> str | None:
    """Return an error string if the file fails a strict full decode, else None.

    Missing files return None too — filesystem reconciliation (sync) already
    self-heals ghost posts; this script only judges files that exist.
    """
    if not abs_path.is_file():
        return None
    try:
        with Image.open(abs_path) as img:
            # Decode every frame: an animation truncated after frame N opens
            # fine but dies on the seek/load of the missing tail.
            for frame in range(getattr(img, "n_frames", 1)):
                img.seek(frame)
                img.load()
    except Exception as exc:  # any decode failure means the file is bad
        return f"{type(exc).__name__}: {exc}"
    return None


def _scan(rows: list[tuple[int, str]], target_dir: Path, workers: int) -> list[tuple[int, str, str]]:
    """Fully decode every post's file; return (id, full_path, error) for failures."""
    bad: list[tuple[int, str, str]] = []
    done = 0

    def task(row: tuple[int, str]) -> tuple[int, str, str] | None:
        pid, full_path = row
        err = _check_one(target_dir / full_path)
        return (pid, full_path, err) if err else None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(task, rows, chunksize=64):
            done += 1
            if result is not None:
                bad.append(result)
            if done % PROGRESS_EVERY == 0:
                print(f"  scanned {done}/{len(rows)} ({len(bad)} bad so far)")
    return bad


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
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help=f"hit-list output (default: {DEFAULT_REPORT})")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 4, help="decode threads (default: cpu count)")
    args = parser.parse_args()

    target_dir = args.db.resolve().parent.parent  # <target_dir>/.pictoria/pictoria.sqlite
    thumbnails_dir = target_dir / ".pictoria" / "thumbnails"
    print(f"DB:         {args.db}")
    print(f"target_dir: {target_dir}")
    print(f"workers:    {args.workers}")
    print(f"mode:       {'APPLY (deleting)' if args.apply else 'DRY-RUN (no changes)'}\n")

    conn = _connect(args.db)
    try:
        rows = [(int(r[0]), r[1]) for r in conn.execute("SELECT id, full_path FROM posts ORDER BY id")]
        print(f"Scanning {len(rows)} posts with strict PIL decode...")
        bad = _scan(rows, target_dir, args.workers)
        if not bad:
            print("No truncated/corrupt images found. Nothing to do.")
            return

        by_err = Counter(err.split("(")[0].strip() for _, _, err in bad)
        print(f"\nFound {len(bad)} corrupt posts:")
        for err, n in by_err.most_common():
            print(f"  {n:6}  {err}")

        args.report.write_text(
            "".join(f"{pid}\t{err}\t{full_path}\n" for pid, full_path, err in bad),
            encoding="utf-8",
        )
        print(f"\nHit list written to {args.report.resolve()}")

        # Phase 1: files on disk (original + thumbnail).
        deleted_files = 0
        for _, full_path, _ in bad:
            if args.apply:
                (target_dir / full_path).unlink(missing_ok=True)
                (thumbnails_dir / full_path).unlink(missing_ok=True)
            deleted_files += 1
        verb = "Deleted" if args.apply else "Would delete"
        print(f"Files:  {verb} {deleted_files} originals (+ thumbnails).")

        # Phase 2: DB rows (+ cascades + vec0).
        ids = [pid for pid, _, _ in bad]
        if args.apply:
            _delete_db_rows(conn, ids)
            print(f"DB:     Deleted {len(ids)} post rows (+ cascaded tags/colors/scores, vec0 cleared).")
        else:
            print(f"DB:     Would delete {len(ids)} post rows (+ cascaded tags/colors/scores, vec0 cleared).")

        if not args.apply:
            print("\nDry-run only. Spot-check the report, then re-run with --apply to delete.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
