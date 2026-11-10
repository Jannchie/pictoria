"""``scripts/backup_db.py``: snapshot / verify / prune on a throwaway database."""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backup_db.py"
_spec = importlib.util.spec_from_file_location("backup_db", _SCRIPT)
assert _spec is not None
assert _spec.loader is not None
backup_db = importlib.util.module_from_spec(_spec)
sys.modules["backup_db"] = backup_db
_spec.loader.exec_module(backup_db)


def _make_db(path: Path, rows: int) -> None:
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE posts (id INTEGER PRIMARY KEY, name TEXT)")
    con.executemany("INSERT INTO posts(name) VALUES (?)", [(f"p{i}",) for i in range(rows)])
    con.commit()
    con.close()


def test_snapshot_is_consistent_and_includes_uncheckpointed_wal(tmp_path: Path) -> None:
    src = tmp_path / "lib" / ".pictoria" / "pictoria.sqlite"
    src.parent.mkdir(parents=True)
    _make_db(src, 3)
    # A writer that is still open with un-checkpointed WAL frames: a plain file copy
    # of the main file would miss this row; VACUUM INTO must not.
    writer = sqlite3.connect(src)
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute("INSERT INTO posts(name) VALUES ('in-wal')")
    writer.commit()
    try:
        dest = backup_db.snapshot(src, tmp_path / "out", now=datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC))
    finally:
        writer.close()
    assert dest.name == "pictoria-20260102T030405Z.sqlite"
    assert not dest.with_suffix(".sqlite.partial").exists()
    con = sqlite3.connect(dest)
    assert con.execute("SELECT count(*) FROM posts").fetchone()[0] == 4
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    con.close()


def test_snapshot_refuses_missing_source_and_existing_dest(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        backup_db.snapshot(tmp_path / "nope.sqlite", tmp_path / "out")
    src = tmp_path / "a.sqlite"
    _make_db(src, 1)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    backup_db.snapshot(src, tmp_path / "out", now=now)
    with pytest.raises(FileExistsError):
        backup_db.snapshot(src, tmp_path / "out", now=now)


def test_prune_keeps_newest(tmp_path: Path) -> None:
    for stamp in ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]:
        (tmp_path / f"pictoria-{stamp}.sqlite").write_bytes(b"")
    (tmp_path / "unrelated.sqlite").write_bytes(b"")
    removed = backup_db.prune(tmp_path, 2)
    assert [p.name for p in removed] == ["pictoria-20260101T000000Z.sqlite"]
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "pictoria-20260102T000000Z.sqlite",
        "pictoria-20260103T000000Z.sqlite",
        "unrelated.sqlite",
    ]
    assert backup_db.prune(tmp_path, 0) == []


def test_main_refuses_out_dir_inside_pictoria(tmp_path: Path) -> None:
    src = tmp_path / "lib" / ".pictoria" / "pictoria.sqlite"
    src.parent.mkdir(parents=True)
    _make_db(src, 1)
    with pytest.raises(SystemExit):
        backup_db.main([str(src.parent / "backups"), "--db", str(src)])
    assert backup_db.main([str(tmp_path / "out"), "--db", str(src), "--keep", "1"]) == 0
    assert len(list((tmp_path / "out").glob("pictoria-*.sqlite"))) == 1
