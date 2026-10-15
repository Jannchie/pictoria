"""Quick inspection of an existing Pictoria SQLite DB file.

    uv run python scripts/inspect_db.py [PATH]

``PATH`` defaults to ``paths.db_path()`` (``DB_PATH`` or the default library).
Opened read-only: the API is the database's only writer.
"""
import sqlite3
import sys
from pathlib import Path

import sqlite_vec

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from paths import db_path

DB_PATH = (Path(sys.argv[1]) if len(sys.argv) > 1 else db_path()).resolve()
print(f"Inspecting: {DB_PATH}")
print(f"Size: {DB_PATH.stat().st_size} bytes\n")

con = sqlite3.connect(f"{DB_PATH.as_uri()}?mode=ro", uri=True, timeout=10.0)
con.enable_load_extension(True)
sqlite_vec.load(con)
con.enable_load_extension(False)

print("--- Tables ---")
tables = con.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name",
).fetchall()
for (t,) in tables:
    try:
        cnt = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        print(f"  {t:30} {cnt:>10} rows")
    except sqlite3.OperationalError as e:
        print(f"  {t:30} (skip: {e})")

print("\n--- Schema versions ---")
try:
    rows = con.execute("SELECT version, applied_at FROM _schema_versions ORDER BY applied_at").fetchall()
    for v, ts in rows:
        print(f"  {v}  @ {ts}")
except Exception as e:
    print(f"  (no _schema_versions table: {e})")

print("\n--- Backfill backlog ---")
try:
    total = con.execute("SELECT count(*) FROM posts").fetchone()[0]

    needs_metadata = con.execute(
        "SELECT count(*) FROM posts "
        "WHERE sha256 = '' OR arthash IS NULL OR arthash = ''",
    ).fetchone()[0]
    metadata_done = total - needs_metadata

    needs_waifu = con.execute(
        "SELECT count(*) FROM posts p "
        "LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id "
        "WHERE pws.post_id IS NULL",
    ).fetchone()[0]
    waifu_done = total - needs_waifu

    # post_vectors_siglip2 is a vec0 virtual table with post_id as its rowid
    # (migration 0006); the CLIP-era post_vectors table is gone (0007).
    needs_embedding = con.execute(
        "SELECT count(*) FROM posts p "
        "WHERE NOT EXISTS (SELECT 1 FROM post_vectors_siglip2 v WHERE v.post_id = p.id)",
    ).fetchone()[0]
    embedding_done = total - needs_embedding

    needs_dom_color = con.execute(
        "SELECT count(*) FROM posts WHERE dominant_color IS NULL",
    ).fetchone()[0]
    dom_color_done = total - needs_dom_color

    def _row(label: str, todo: int, done: int) -> None:
        pct = (done / total * 100) if total else 0.0
        print(f"  {label:18} todo={todo:>8}  done={done:>8} / {total} ({pct:5.1f}%)")

    print(f"  total posts:        {total}")
    _row("metadata", needs_metadata, metadata_done)
    _row("waifu score", needs_waifu, waifu_done)
    _row("siglip2 embedding", needs_embedding, embedding_done)
    _row("dominant color", needs_dom_color, dom_color_done)
except Exception as e:
    print(f"  error: {e}")

con.close()
