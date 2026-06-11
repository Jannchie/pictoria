"""Cursor → Pydantic conversion helpers.

sqlite3 cursors expose ``description`` (column metadata) after ``execute()``,
which lets us zip rows into dicts and validate them into entity models.
``Connection.row_factory = sqlite3.Row`` is set on every connection so plain
``cur.fetchone()`` indexing also works by both position and name.
"""

from __future__ import annotations

import json
import struct
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import BaseModel

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator

T = TypeVar("T", bound=BaseModel)


@contextmanager
def transaction(cur: sqlite3.Cursor) -> Iterator[None]:
    """Wrap multi-statement writes in an explicit BEGIN/COMMIT.

    Connections run with ``isolation_level=None`` (autocommit), so any write
    that must keep multiple statements consistent — delete-with-children,
    pointer swaps, mirrored updates — needs this; otherwise an interruption
    (crash, SQLITE_BUSY under backfill) commits a half-applied state.
    """
    cur.execute("BEGIN")
    try:
        yield
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise


def decode_dominant_color(v: Any) -> list[float] | None:
    """Decode a sqlite-vec FLOAT[3] BLOB, JSON string, or list to ``list[float]``."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        n = len(b) // 4
        if n == 0:
            return None
        return list(struct.unpack(f"{n}f", b))
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        return json.loads(v)
    msg = f"Cannot decode dominant_color from {type(v).__name__}"
    raise ValueError(msg)


def sql_placeholders(items: tuple | list) -> str:
    """Return a comma-separated ``?`` placeholder string for SQL ``IN (...)``."""
    return ",".join("?" * len(items))


def _column_names(cur: sqlite3.Cursor) -> list[str]:
    desc = cur.description
    if desc is None:
        return []
    return [d[0] for d in desc]


def fetch_one_as(cur: sqlite3.Cursor, model_cls: type[T]) -> T | None:
    row = cur.fetchone()
    if row is None:
        return None
    cols = _column_names(cur)
    return model_cls.model_validate(dict(zip(cols, row, strict=False)))


def fetch_all_as(cur: sqlite3.Cursor, model_cls: type[T]) -> list[T]:
    rows = cur.fetchall()
    if not rows:
        return []
    cols = _column_names(cur)
    return [model_cls.model_validate(dict(zip(cols, row, strict=False))) for row in rows]


def fetch_all_dicts(cur: sqlite3.Cursor) -> list[dict]:
    rows = cur.fetchall()
    if not rows:
        return []
    cols = _column_names(cur)
    return [dict(zip(cols, row, strict=False)) for row in rows]


def fetch_one_dict(cur: sqlite3.Cursor) -> dict | None:
    row = cur.fetchone()
    if row is None:
        return None
    cols = _column_names(cur)
    return dict(zip(cols, row, strict=False))
