"""Quick inspection of an existing DuckDB file."""
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import duckdb

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else r"E:\pictoria\server\illustration\images\.pictoria\pictoria.duckdb"
print(f"Inspecting: {DB_PATH}")
print(f"Size: {Path(DB_PATH).stat().st_size} bytes\n")

con = duckdb.connect(DB_PATH, read_only=True)

print("--- Tables ---")
tables = con.execute(
    "SELECT table_name FROM information_schema.tables "
    "WHERE table_schema='main' ORDER BY table_name",
).fetchall()
for (t,) in tables:
    cnt = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
    print(f"  {t:25} {cnt:>10} rows")

print("\n--- Schema versions ---")
try:
    rows = con.execute("SELECT version, applied_at FROM _schema_versions ORDER BY applied_at").fetchall()
    for v, ts in rows:
        print(f"  {v}  @ {ts}")
except Exception as e:
    print(f"  (no _schema_versions table: {e})")

print("\n--- HNSW indexes ---")
try:
    idx = con.execute(
        "SELECT index_name, table_name FROM duckdb_indexes "
        "WHERE index_name LIKE 'hnsw_%'",
    ).fetchall()
    for n, t in idx:
        print(f"  {n} on {t}")
except Exception as e:
    print(f"  error: {e}")

con.close()
