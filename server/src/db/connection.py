from __future__ import annotations

import contextlib
import sqlite3
import threading
from pathlib import Path

import sqlite_vec


class DB:
    """Single-process SQLite connection holder with sqlite-vec loaded.

    sqlite3 connections aren't safe to share across threads by default. Each
    call to :meth:`cursor` returns a thread-local connection (created lazily
    once per thread) so worker threads scheduled by ``asyncio.to_thread`` can
    each do their own work without explicit locking.

    Every connection has the ``sqlite-vec`` extension loaded so ``vec0``
    virtual tables are usable, and is configured with WAL + foreign keys
    on for OLTP-friendly behaviour.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        # Track every connection we hand out (thread-local cache *and*
        # ``new_connection()`` returns) so shutdown can close them all,
        # not just the one in the calling thread's local.
        self._all_conns: set[sqlite3.Connection] = set()
        self._all_conns_lock = threading.Lock()
        self._closed = False
        # Configure the main connection eagerly so PRAGMAs that take effect
        # database-wide (journal_mode, synchronous, foreign_keys default) are
        # set before any worker connection arrives.
        self._configure(self._get_local())

    # ─── connection plumbing ────────────────────────────────────────────

    def _new_connection(self) -> sqlite3.Connection:
        if self._closed:
            msg = "DB has been closed; cannot open new connections"
            raise RuntimeError(msg)
        conn = sqlite3.connect(
            str(self.path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; transactions managed explicitly
            timeout=30.0,
        )
        conn.row_factory = sqlite3.Row
        conn.enable_load_extension(True)  # noqa: FBT003
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)  # noqa: FBT003
        # PRAGMAs are connection-scoped (mostly) but foreign_keys is enforced
        # per-connection — set it on every cursor.
        conn.execute("PRAGMA foreign_keys = ON")
        with self._all_conns_lock:
            self._all_conns.add(conn)
        return conn

    def _configure(self, conn: sqlite3.Connection) -> None:
        # Database-wide settings — only need to set once but idempotent so
        # cheap to repeat.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.execute("PRAGMA mmap_size = 30000000000")  # 30 GB cap, OS clamps to RAM

    def _get_local(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
        return conn

    # ─── public API expected by repositories ────────────────────────────

    def cursor(self) -> sqlite3.Cursor:
        """Return a fresh cursor on this thread's underlying connection.

        Repository code calls ``cur.execute(...)`` followed by ``cur.fetchone()``
        / ``cur.fetchall()`` — that pattern requires a real ``sqlite3.Cursor``
        object (the ``Connection`` itself doesn't expose ``fetchone``). The
        cursor's lifetime is tied to the calling code, but the underlying
        connection lives in ``self._local`` until ``close()``.
        """
        return self._get_local().cursor()

    def new_connection(self) -> sqlite3.Connection:
        """Return a fresh, fully-configured connection that bypasses the thread-local cache.

        Useful for background workers that want their own isolated connection
        so cursors don't share state with the main request-serving connection.
        Caller owns the returned connection and must ``close()`` it.

        Multiple cursors on a *single* shared connection accessed from multiple
        ``asyncio.to_thread`` worker threads have proven flaky in practice
        (the cursor's ``description``/result-row state can desync from what
        ``execute()`` actually selected). A dedicated connection per worker
        sidesteps that entirely.
        """
        conn = self._new_connection()
        self._configure(conn)
        return conn

    def close(self) -> None:
        """Close every connection this DB has handed out, from every thread.

        Worker threads each have their own thread-local connection (and
        ``new_connection()`` returns more), so closing just the caller's
        thread-local one leaves the rest open and writing — which races
        the rest of shutdown. ``_all_conns`` lets us close them all.
        """
        self._closed = True
        with self._all_conns_lock:
            conns = list(self._all_conns)
            self._all_conns.clear()
        for conn in conns:
            with contextlib.suppress(Exception):
                conn.close()
        # Drop the thread-local cache so a stray ``cursor()`` call after
        # close raises via the ``_closed`` guard instead of silently
        # opening a new connection.
        self._local = threading.local()

    @property
    def raw(self) -> sqlite3.Connection:
        return self._get_local()
