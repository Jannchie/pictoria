"""Reconcile filesystem files with the posts table.

Native DuckDB version: takes a PostRepo and runs sync DB work via
``asyncio.to_thread`` to stay event-loop friendly.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

import shared
from shared import logger

if TYPE_CHECKING:
    from db.repositories.posts import PostRepo


async def remove_deleted_files(
    posts: PostRepo,
    *,
    os_tuples_set: set[tuple[str, str, str]],
    db_tuples_set: set[tuple[str, str, str]],
) -> None:
    deleted = db_tuples_set - os_tuples_set
    if not deleted:
        return
    logger.info(f"Detected {len(deleted)} files have been deleted")
    for path_name_ext in deleted:
        await _delete_by_triple(posts, path_name_ext)
    logger.info("Deleted files from database")


async def _delete_by_triple(posts: PostRepo, triple: tuple[str, str, str]) -> None:
    file_path, file_name, extension = triple

    def _find_and_delete() -> int | None:
        posts.cur.execute(
            "SELECT id FROM posts WHERE file_path = ? AND file_name = ? AND extension = ?",
            [file_path, file_name, extension],
        )
        row = posts.cur.fetchone()
        return row[0] if row else None

    pid = await asyncio.to_thread(_find_and_delete)
    if pid is not None:
        await posts.delete_one(pid)
    # remove thumbnail + (if intended) source file from disk
    relative = Path(file_path) / file_name
    if extension:
        relative = relative.with_suffix(f".{extension}")
    thumb = shared.thumbnails_dir / relative
    source = shared.target_dir / relative
    if thumb.exists():
        thumb.unlink()
    if source.exists():
        source.unlink()


async def add_new_files(
    posts: PostRepo,
    *,
    os_tuples_set: set[tuple[str, str, str]],
    db_tuples_set: set[tuple[str, str, str]],
) -> None:
    new_files = os_tuples_set - db_tuples_set
    if not new_files:
        return
    logger.info(f"Detected {len(new_files)} new files")
    for file_path, file_name, extension in new_files:
        await posts.create(
            file_path=file_path,
            file_name=file_name,
            extension=extension,
        )
    logger.info("Added new files to database")
