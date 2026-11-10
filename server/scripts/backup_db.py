"""Consistent snapshot of the Pictoria database, optionally uploaded with rclone.

    uv run python scripts/backup_db.py OUT_DIR [--db PATH] [--upload REMOTE] [--keep N]

Why not just copy the file: the API keeps ``pictoria.sqlite`` open in WAL mode, so
the bytes on disk at any instant are the main file *plus* an uncheckpointed
``-wal``. Copying either alone (which is what syncing ``.pictoria/`` used to do)
can give a file that is missing recent writes or fails ``integrity_check``.
``VACUUM INTO`` runs inside one read transaction and writes a self-contained,
compacted copy -- safe while the API is running, and it never writes the source.

- ``OUT_DIR``: where snapshots go (created if missing). Must not be inside the
  library's ``.pictoria/`` -- that directory is excluded from the image sync, so a
  backup there would not leave the machine.
- ``--db``: source database; defaults to ``paths.db_path()`` (``DB_PATH`` or
  ``<library>/.pictoria/pictoria.sqlite``).
- ``--upload``: an rclone destination directory (e.g. ``b2:pictoria/db-backups``);
  the snapshot is copied there after it has been verified.
- ``--keep``: after a successful snapshot, keep only the newest N in ``OUT_DIR``.

``tasks.sqlite`` (the cairnq queue) is not backed up: it is transient work state,
and an empty one is recreated on boot. Restore steps are in ``scripts/README.md``.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from paths import db_path, pictoria_dir

SNAPSHOT_PREFIX = "pictoria-"
SNAPSHOT_SUFFIX = ".sqlite"


def _connect(path: Path, *, read_only: bool) -> sqlite3.Connection:
    uri = f"{path.as_uri()}?mode=ro" if read_only else path.as_uri()
    con = sqlite3.connect(uri, uri=True, timeout=30.0)
    # vec0 virtual tables: loading the module keeps every statement (including the
    # integrity check below) able to see them. Optional so the script still works
    # on a plain DB (tests) if sqlite_vec is unavailable.
    try:
        import sqlite_vec  # noqa: PLC0415

        con.enable_load_extension(True)
        sqlite_vec.load(con)
        con.enable_load_extension(False)
    except ImportError:
        pass
    return con


def snapshot(src: Path, out_dir: Path, *, now: datetime | None = None) -> Path:
    """``VACUUM INTO`` a timestamped file in ``out_dir``, verify it, return its path."""
    if not src.is_file():
        msg = f"source database not found: {src}"
        raise FileNotFoundError(msg)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    dest = out_dir / f"{SNAPSHOT_PREFIX}{stamp}{SNAPSHOT_SUFFIX}"
    if dest.exists():
        msg = f"snapshot already exists: {dest}"
        raise FileExistsError(msg)
    partial = dest.with_suffix(dest.suffix + ".partial")
    partial.unlink(missing_ok=True)

    con = _connect(src, read_only=True)
    try:
        # Bound parameter, not string interpolation: the path may contain quotes.
        con.execute("VACUUM INTO ?", (str(partial),))
    finally:
        con.close()

    check = _connect(partial, read_only=True)
    try:
        result = check.execute("PRAGMA quick_check").fetchone()[0]
    finally:
        check.close()
    if result != "ok":
        partial.unlink(missing_ok=True)
        msg = f"snapshot failed quick_check: {result}"
        raise RuntimeError(msg)
    partial.rename(dest)
    return dest


def prune(out_dir: Path, keep: int) -> list[Path]:
    """Delete all but the newest ``keep`` snapshots in ``out_dir``; return what was removed."""
    snaps = sorted(p for p in out_dir.glob(f"{SNAPSHOT_PREFIX}*{SNAPSHOT_SUFFIX}") if p.is_file())
    doomed = snaps[:-keep] if keep > 0 else []
    for p in doomed:
        p.unlink()
    return doomed


def upload(path: Path, remote: str) -> None:
    rclone = shutil.which("rclone")
    if rclone is None:
        msg = "rclone not found on PATH (see scripts/setup_rclone.md)"
        raise RuntimeError(msg)
    dest = f"{remote.rstrip('/')}/{path.name}"
    subprocess.run([rclone, "copyto", "--", str(path), dest], check=True)  # noqa: S603


def _is_inside(target: Path, root: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("out_dir", type=Path, help="directory to write the snapshot into")
    parser.add_argument("--db", type=Path, default=None, help="source database (default: paths.db_path())")
    parser.add_argument("--upload", metavar="REMOTE", default=None, help="rclone destination dir, e.g. b2:pictoria/db-backups")
    parser.add_argument("--keep", type=int, default=0, help="keep only the newest N snapshots in OUT_DIR (0 = keep all)")
    args = parser.parse_args(argv)

    src = (args.db or db_path()).resolve()
    out_dir = args.out_dir.resolve()
    forbidden = [pictoria_dir()]
    if src.parent.name == ".pictoria":
        forbidden.append(src.parent)
    if any(_is_inside(out_dir, f) for f in forbidden):
        parser.error(f"OUT_DIR must not be inside the library's .pictoria/ (it is excluded from sync): {out_dir}")

    dest = snapshot(src, out_dir)
    print(f"snapshot: {dest} ({dest.stat().st_size / 1e6:.1f} MB)")
    if args.upload:
        upload(dest, args.upload)
        print(f"uploaded: {args.upload.rstrip('/')}/{dest.name}")
    for p in prune(out_dir, args.keep):
        print(f"pruned: {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
