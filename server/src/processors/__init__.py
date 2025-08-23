import asyncio
from io import BufferedReader
from pathlib import Path

import numpy as np
from PIL import Image
from rich.progress import Progress
from skimage import color  # 使用 scikit-image 库
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from ai.clip import calculate_image_features
from models import Post, PostHasColor, PostVector
from shared import logger
from tools.colors import get_dominant_color, get_palette_ints
from utils import (
    add_new_files,
    async_session,
    attach_tags_to_post,
    calculate_sha256,
    compute_image_properties,
    find_files_in_directory,
    from_rating_to_int,
    get_path_name_and_extension,
    get_tagger,
    remove_deleted_files,
)

# Store task references to prevent garbage collection
_background_tasks = set()


async def sync_metadata():
    loop = asyncio.get_event_loop()
    task = loop.create_task(_sync_metadata())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _sync_metadata() -> None:
    os_tuples = find_files_in_directory(shared.target_dir)

    session = await async_session()
    rows = await session.execute(select(Post.file_path, Post.file_name, Post.extension))
    db_tuples = rows.fetchall()
    logger.info(f"Found {len(db_tuples)} files in database")

    db_tuples_set = set(db_tuples)
    os_tuples_set = set(os_tuples)

    await remove_deleted_files(session, os_tuples_set=os_tuples_set, db_tuples_set=db_tuples_set)
    await add_new_files(session, os_tuples_set=os_tuples_set, db_tuples_set=db_tuples_set)
    await process_posts(session)


async def process_posts(session: AsyncSession, *, all_posts: bool = False):
    """Process posts in the database. Including calculating SHA256 hash, size, and creating thumbnails.

    Args:
        all (bool, optional): Process all posts or only those without an SHA256 hash. Defaults to False.
    """
    target_dir = shared.target_dir
    posts = (await session.scalars(select(Post))).all() if all_posts else (await session.scalars(select(Post).where(Post.sha256 == ""))).all()
    with Progress(console=shared.console) as progress:
        if not posts:
            logger.info("No posts to process")
            return
        task = progress.add_task("Processing posts...", total=len(posts))
        for post in posts:
            # 构建文件的完整路径。
            file_abs_path = target_dir / post.file_path / f"{post.file_name}.{post.extension}"
            await process_post(session, file_abs_path)
            progress.update(task, advance=1)


async def process_post(session: AsyncSession, file_abs_path: Path | None = None):
    file_path, file_name, extension = get_path_name_and_extension(file_abs_path)
    post = await session.execute(select(Post).filter(Post.file_path == file_path, Post.file_name == file_name, Post.extension == extension))
    post = post.scalar_one_or_none()
    if post is None:
        logger.info(f"Post not found in database: {file_abs_path}")
        return
    if post.sha256:
        logger.info(f"Skipping post: {file_abs_path}")
        return
    file_data = None
    try:
        if file_abs_path is None:
            file_abs_path = shared.target_dir / post.file_path / post.file_name
            file_abs_path = file_abs_path.with_suffix(f".{post.extension}")
        if file_abs_path.suffix.lower() not in [
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".webp",
            ".avif",
        ]:
            logger.debug(f"Skipping not image file: {file_abs_path}")
            return
        logger.info(f"Processing post: {file_abs_path}")
        with file_abs_path.open("rb") as file:
            file_data = file.read()
            file.seek(0)  # 重置文件指针位置
            with Image.open(file) as img:
                compute_image_properties(img, post, file_abs_path)
            file.seek(0)
            set_post_colors(post, file)
    except Exception as e:
        if file_data:
            file_abs_path.unlink()
        logger.warning(f"Error processing file: {file_abs_path}")
        logger.exception(e)
        session.rollback()
        return

    if file_data:
        post.sha256 = calculate_sha256(file_data)
        post.size = file_abs_path.stat().st_size
    session.add(post)

    # calculate features
    features = await asyncio.to_thread(calculate_image_features, file_abs_path)
    embedding = features.cpu().numpy()[0]
    # session.add(PostVector(post_id=post.id, embedding=features.cpu().numpy()[0]))
    await session.execute(
        insert(PostVector)
        .values(post_id=post.id, embedding=embedding)
        .on_conflict_do_update(
            index_elements=["post_id"],
            set_={
                "embedding": embedding,
            },
        ),
    )
    # calculate tags
    tagger = get_tagger()
    resp = tagger.tag(file_abs_path)
    logger.debug(resp)
    if post.rating == 0:
        post.rating = from_rating_to_int(resp.rating)
    await attach_tags_to_post(session, post, resp, is_auto=True)
    await session.flush()


def rgb_to_lab_skimage(rgb_tuple: tuple[int, int, int]):
    rgb_normalized = np.array(rgb_tuple, dtype=np.float64) / 255.0
    return color.rgb2lab(rgb_normalized.reshape(1, 1, 3)).reshape(3)


def set_post_colors(post: Post, file: None | BufferedReader = None):
    if post.colors:
        return
    arg = post.absolute_path.as_posix() if file is None else file
    colors = get_palette_ints(arg)
    rgb_dominant_color = get_dominant_color(arg)
    post.dominant_color = rgb_to_lab_skimage(rgb_dominant_color)
    post.colors.extend(PostHasColor(post_id=post.id, order=i, color=color) for i, color in enumerate(colors))
