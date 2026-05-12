"""Cursor → Pydantic conversion helpers.

DuckDB cursors expose ``description`` (column metadata) after ``execute()``,
which lets us zip rows into dicts and validate them into entity models.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar

from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Iterable

    import duckdb

T = TypeVar("T", bound=BaseModel)


def _column_names(cur: duckdb.DuckDBPyConnection) -> list[str]:
    desc = cur.description
    if desc is None:
        return []
    return [d[0] for d in desc]


def fetch_one_as(cur: duckdb.DuckDBPyConnection, model_cls: type[T]) -> T | None:
    row = cur.fetchone()
    if row is None:
        return None
    cols = _column_names(cur)
    return model_cls.model_validate(dict(zip(cols, row, strict=False)))


def fetch_all_as(cur: duckdb.DuckDBPyConnection, model_cls: type[T]) -> list[T]:
    rows = cur.fetchall()
    if not rows:
        return []
    cols = _column_names(cur)
    return [model_cls.model_validate(dict(zip(cols, row, strict=False))) for row in rows]


def fetch_all_dicts(cur: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = cur.fetchall()
    if not rows:
        return []
    cols = _column_names(cur)
    return [dict(zip(cols, row, strict=False)) for row in rows]


def fetch_one_dict(cur: duckdb.DuckDBPyConnection) -> dict | None:
    row = cur.fetchone()
    if row is None:
        return None
    cols = _column_names(cur)
    return dict(zip(cols, row, strict=False))


def rows_to_models(
    rows: Iterable[tuple],
    columns: list[str],
    model_cls: type[T],
) -> list[T]:
    """Convert pre-fetched rows + known column names to entity models."""
    return [model_cls.model_validate(dict(zip(columns, row, strict=False))) for row in rows]
