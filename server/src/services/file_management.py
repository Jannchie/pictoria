"""Reconcile filesystem files with the posts table.

Bulk version: a single INSERT executemany for new files, a single
``delete_many(ids)`` for removals, file unlinks done in batch. Used to be
``for triple in deltas: await one_at_a_time(...)`` — that meant 2-3 cursor
round-trips per file, which dominated the wall-clock cost of a 100k+ scan.
"""

from __future__ import annotations

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
    db_path_to_id: dict[tuple[str, str, str], int],
) -> None:
    deleted = set(db_path_to_id.keys()) - os_tuples_set
    if not deleted:
        return
    logger.info(f"Detected {len(deleted)} files have been deleted")

    ids = [db_path_to_id[triple] for triple in deleted]
    await posts.delete_many(ids)

    # Unlink thumbnails + source files. These are best-effort: if the source
    # is already gone (which is the usual reason it shows up in deleted),
    # ``unlink(missing_ok=True)`` simply succeeds.
    for file_path, file_name, extension in deleted:
        relative = Path(file_path) / file_name
        if extension:
            relative = relative.with_suffix(f".{extension}")
        (shared.thumbnails_dir / relative).unlink(missing_ok=True)
        (shared.target_dir / relative).unlink(missing_ok=True)

    logger.info("Deleted files from database")


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
    await posts.create_paths(list(new_files))
    logger.info("Added new files to database")
