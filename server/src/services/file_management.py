from pathlib import Path

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from models import Post
from shared import logger


async def remove_deleted_files(
    session: AsyncSession,
    *,
    os_tuples_set: set[tuple[str, str, str]],
    db_tuples_set: set[tuple[str, str, str]],
):
    if deleted_files := db_tuples_set - os_tuples_set:
        logger.info(f"Detected {len(deleted_files)} files have been deleted")
        for file_path in deleted_files:
            await delete_by_file_path_and_ext(session, file_path)
        await session.commit()
        logger.info("Deleted files from database")


async def delete_by_file_path_and_ext(session: AsyncSession, path_name_and_ext: tuple[str, str, str]):
    await session.execute(
        delete(Post).where(
            Post.file_path == path_name_and_ext[0],
            Post.file_name == path_name_and_ext[1],
            Post.extension == path_name_and_ext[2],
        ),
    )
    await session.commit()
    if path_name_and_ext[2]:
        relative_path = (Path(path_name_and_ext[0]) / path_name_and_ext[1]).with_suffix(f".{path_name_and_ext[2]}")
    else:
        relative_path = Path(path_name_and_ext[0]) / path_name_and_ext[1]
    file_path = shared.target_dir / relative_path
    thumbnails_path = shared.thumbnails_dir / relative_path
    if thumbnails_path.exists():
        thumbnails_path.unlink()
    if file_path.exists():
        file_path.unlink()


async def add_new_files(
    session: AsyncSession,
    *,
    os_tuples_set: set[tuple[str, str, str]],
    db_tuples_set: set[tuple[str, str, str]],
):
    if new_file_tuples := os_tuples_set - db_tuples_set:
        logger.info(f"Detected {len(new_file_tuples)} new files")
        for file_tuple in new_file_tuples:
            post = Post(file_path=file_tuple[0], file_name=file_tuple[1], extension=file_tuple[2])
            session.add(post)
        await session.commit()
        logger.info("Added new files to database")
