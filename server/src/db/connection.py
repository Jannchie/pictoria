from __future__ import annotations

from pathlib import Path

import duckdb


class DB:
    """Single-process DuckDB connection holder.

    Owns one underlying duckdb.DuckDBPyConnection. Worker threads obtain
    independent cursors via ``cursor()`` — each cursor is configured with
    the VSS extension loaded and the runtime settings reapplied, since
    DuckDB scopes ``SET`` and ``LOAD`` per connection.
    """

    def __init__(
        self,
        path: Path,
        *,
        memory_limit: str = "4GB",
        threads: int = 4,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._memory_limit = memory_limit
        self._threads = threads
        self._conn = duckdb.connect(str(self.path))
        # INSTALL is database-level (one-time download), runs once per process.
        self._conn.execute("INSTALL vss")
        # Configure the primary connection.
        self._configure(self._conn)

    def _configure(self, conn: duckdb.DuckDBPyConnection) -> None:
        conn.execute("LOAD vss")
        conn.execute("SET hnsw_enable_experimental_persistence=true")
        conn.execute(f"SET memory_limit='{self._memory_limit}'")
        conn.execute(f"SET threads={self._threads}")

    def cursor(self) -> duckdb.DuckDBPyConnection:
        """Return a configured cursor for executing queries on this DB.

        DuckDB cursors are independent connection-like objects sharing the
        underlying database. Each one needs ``LOAD vss`` and the session
        settings applied so that HNSW indexes work correctly.
        """
        cur = self._conn.cursor()
        self._configure(cur)
        return cur

    def close(self) -> None:
        self._conn.close()

    @property
    def raw(self) -> duckdb.DuckDBPyConnection:
        return self._conn
