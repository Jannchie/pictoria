from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3
    from pathlib import Path

logger = logging.getLogger("pictoria.migrator")


def run_migrations(conn: sqlite3.Connection | sqlite3.Cursor, migrations_dir: Path) -> int:
    """Apply pending ``*.sql`` migrations from ``migrations_dir``.

    Migration filenames are sorted lexicographically (e.g. ``0001_initial.sql``,
    ``0002_add_x.sql``). Applied versions are tracked in ``_schema_versions``.
    Each file is run as a single multi-statement transaction via
    ``executescript`` (which sqlite3 implicitly wraps).

    Returns the number of migrations applied in this run.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS _schema_versions (
            version    TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """,
    )
    applied: set[str] = {
        row[0]
        for row in conn.execute("SELECT version FROM _schema_versions").fetchall()
    }

    pending = sorted(
        f for f in migrations_dir.glob("*.sql") if f.stem not in applied
    )
    if not pending:
        logger.info("No pending migrations")
        return 0

    # ``executescript`` issues an implicit COMMIT before running and runs the
    # batch as one transaction; we append the version-record INSERT so the
    # schema change and its bookkeeping land atomically.
    underlying = conn if hasattr(conn, "executescript") else conn.connection
    for sql_file in pending:
        version = sql_file.stem
        logger.info("Applying migration: %s", version)
        sql_text = sql_file.read_text(encoding="utf-8")
        # Single-quote-escape the version string for safe inlining.
        version_sql = version.replace("'", "''")
        script = (
            f"{sql_text.rstrip().rstrip(';')};\n"
            f"INSERT INTO _schema_versions(version) VALUES ('{version_sql}');"
        )
        try:
            underlying.executescript(script)
        except Exception:
            logger.exception("Migration failed: %s", version)
            raise

    logger.info("Applied %d migration(s)", len(pending))
    return len(pending)
