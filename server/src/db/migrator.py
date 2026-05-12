from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

    import duckdb

logger = logging.getLogger("pictoria.migrator")


def run_migrations(conn: duckdb.DuckDBPyConnection, migrations_dir: Path) -> int:
    """Apply pending ``*.sql`` migrations from ``migrations_dir``.

    Migration filenames are sorted lexicographically (e.g. ``0001_initial.sql``,
    ``0002_add_x.sql``). Applied versions are tracked in ``_schema_versions``.
    Each file is run as a single multi-statement transaction.

    Returns the number of migrations applied in this run.
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS _schema_versions (
            version VARCHAR PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

    for sql_file in pending:
        version = sql_file.stem
        logger.info("Applying migration: %s", version)
        sql_text = sql_file.read_text(encoding="utf-8")
        try:
            conn.execute("BEGIN")
            conn.execute(sql_text)
            conn.execute(
                "INSERT INTO _schema_versions(version) VALUES (?)",
                [version],
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            logger.exception("Migration failed: %s", version)
            raise

    logger.info("Applied %d migration(s)", len(pending))
    return len(pending)
