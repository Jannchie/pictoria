"""Fetch images by creator/tag URL list via gallery-dl, persist to the library.

Reads a newline-delimited URL list (default: server/creators.txt), runs each
through services.gallery_dl_import, and reports per-URL results. Dry-run by
default: fetches metadata + dedupes against the DB but downloads / writes
nothing.

Run from the server/ dir:
    uv run python scripts/fetch_creators.py                 # dry-run (default)
    uv run python scripts/fetch_creators.py --apply         # download + persist
    uv run python scripts/fetch_creators.py --apply --sync  # + sync-metadata hint
    uv run python scripts/fetch_creators.py --list my.txt --config gallery-dl.conf
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
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

import shared
from server.commands import ensure_canonical_tag_groups_sync
from services.gallery_dl_import import import_from_url, parse_creators_file

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"
DEFAULT_LIST = SERVER_ROOT / "creators.txt"


class _DBShim:
    """Minimal db.cursor()/commit()/rollback() for gallery_dl_import.

    The single-threaded script reuses one connection, unlike the request-scoped
    thread-local cursors the app's DB hands out.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def cursor(self) -> sqlite3.Cursor:
        return self._conn.cursor()

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)  # gallery_dl_import never touches vec0, but keep parity with the app
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _import_one(db: _DBShim, url: str, type_to_group: dict, *, apply: bool, config_path: str | None) -> str:
    """Import one URL, commit/rollback per URL, return a one-line report.

    A failure (bad URL, CF block, write error) is caught here so the driver loop
    keeps going — and keeping the try out of the loop avoids PERF203.
    """
    try:
        s = import_from_url(url, db=db, type_to_group_id=type_to_group, apply=apply, config_path=config_path)
    except Exception as exc:
        db.rollback()
        return f"  FAIL {url}\n       {exc}"
    db.commit()
    return (f"  OK   {url}\n"
            f"       fetched={s.fetched} images={s.images} "
            f"new={s.new} downloaded={s.downloaded} failed={s.failed}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST, help=f"URL list (default: {DEFAULT_LIST})")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite path (default: {DEFAULT_DB})")
    parser.add_argument("--config", type=Path, default=None, help="gallery-dl.conf path (cookies/UA for Kemono)")
    parser.add_argument("--apply", action="store_true", help="download + persist (default: dry-run)")
    parser.add_argument("--sync", action="store_true", help="print a sync-metadata reminder afterwards")
    args = parser.parse_args()

    if not args.list.is_file():
        print(f"List file not found: {args.list}")
        return
    urls = parse_creators_file(args.list.read_text(encoding="utf-8"))
    # Downloads land under shared.target_dir; derive it from the DB path
    # (<target_dir>/.pictoria/pictoria.sqlite), mirroring the app's layout.
    shared.target_dir = args.db.resolve().parent.parent
    print(f"List:       {args.list} ({len(urls)} urls)")
    print(f"DB:         {args.db}")
    print(f"target_dir: {shared.target_dir}")
    print(f"mode:       {'APPLY (download + persist)' if args.apply else 'DRY-RUN (no changes)'}\n")

    conn = _connect(args.db)
    db = _DBShim(conn)
    try:
        type_to_group = ensure_canonical_tag_groups_sync(conn.cursor())
        conn.commit()
        config_path = str(args.config) if args.config else None
        for url in urls:
            print(_import_one(db, url, type_to_group, apply=args.apply, config_path=config_path))
    finally:
        conn.close()

    if args.apply and args.sync:
        print("\n--sync: now POST /v2/cmd/sync-metadata (or restart) to backfill embedding/scores/auto-tags.")
    elif args.apply:
        print("\nDone. Run sync-metadata to backfill embedding / scores / auto-tags.")
    else:
        print("\nDry-run only. Re-run with --apply to download and persist.")


if __name__ == "__main__":
    main()
