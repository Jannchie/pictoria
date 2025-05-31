import argparse
import hashlib
import os
import sys
import threading
import time
from collections.abc import AsyncGenerator, Callable
from functools import cache, wraps
from pathlib import Path
from typing import Any, TypeVar

import wdtagger
from dotenv import load_dotenv
from PIL import Image
from sqlalchemy import create_engine, delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, sessionmaker

import shared
from models import Post, PostHasTag, Tag, TagGroup
from shared import logger

load_dotenv()

# 定义泛型变量，用于注释被装饰的可调用对象的返回类型
R = TypeVar("R")


def timer(func: Callable[..., R]) -> Callable[..., R]:
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> R:
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        execution_time = end_time - start_time
        logger.info(f"Function '{func.__name__}' executed in: {execution_time:.4f} seconds")
        return result

    return wrapper


def initialize(target_dir: os.PathLike, openai_key: str | None = None) -> None:
    prepare_paths(Path(target_dir))
    prepare_openai_api(openai_key)
    init_thumbnails_directory()


def prepare_openai_api(openai_key: str | None) -> None:
    if not shared.pictoria_dir:
        logger.warning("Pictoria directory not set, skipping OpenAI API key setup")
        return
    if shared.pictoria_dir.joinpath("OPENAI_API_KEY").exists():
        with shared.pictoria_dir.joinpath("OPENAI_API_KEY").open() as f:
            shared.openai_key = f.read().strip()
    if openai_key:
        shared.openai_key = openai_key


def prepare_paths(target_path: Path) -> None:
    shared.target_dir = get_target_dir(target_path)
    shared.pictoria_dir = get_pictoria_directory()


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4777)
    parser.add_argument("--target_dir", type=str, default=".")
    parser.add_argument("--openai_key", type=str, default=None)
    return parser.parse_args()


def get_pictoria_directory():
    pictoria_dir = shared.target_dir / ".pictoria"
    if not pictoria_dir.exists():
        pictoria_dir.mkdir()
        logger.info(f'Created directory "{pictoria_dir}"')
    return pictoria_dir


def validate_path(target_path: Path):
    if not target_path.exists():
        logger.info(f'Error: Path "{target_path}" does not exist')
        sys.exit(1)


def get_target_dir(target_path: Path) -> Path:
    target_dir = target_path.resolve()
    validate_path(target_dir)
    logger.info(f"Target directory: {target_dir}")
    return target_dir


def init_thumbnails_directory():
    shared.thumbnails_dir = shared.pictoria_dir / "thumbnails"
    logger.info(f"Thumbnails directory: {shared.thumbnails_dir}")
    if not shared.thumbnails_dir.exists():
        shared.thumbnails_dir.mkdir()
        logger.info(f'Created directory "{shared.thumbnails_dir}"')


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
    session: Session,
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


@cache
def get_engine():
    db_url = os.environ.get("DB_URL")
    return create_engine(db_url, echo=False, pool_size=100, max_overflow=200)


def get_session():
    engine = get_engine()
    my_session = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    return my_session()


@cache
def get_async_engine():
    db_url = os.environ.get("DB_URL")
    return create_async_engine(db_url, echo=False, pool_size=100, max_overflow=200)


async def async_session():
    engine = get_async_engine()
    async_session = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    return async_session()


async def async_transaction() -> AsyncGenerator[AsyncSession, None]:
    session = await async_session()
    async with session.begin():
        yield session


def get_relative_path(file_path: Path, target_dir: Path) -> str:
    return file_path.relative_to(target_dir).parent.as_posix()


def get_file_name(file_path: Path) -> str:
    return file_path.stem


def get_file_extension(file_path: Path) -> str:
    return file_path.suffix[1:]


def find_files_in_directory(target_dir: Path) -> list[tuple[str, str, str]]:
    os_tuples: list[tuple[str, str, str]] = []
    for file_path in target_dir.rglob("*"):
        relative_path = file_path.relative_to(target_dir)
        if file_path.is_file() and not relative_path.parts[0].startswith("."):
            path = get_relative_path(file_path, target_dir)
            name = get_file_name(file_path)
            ext = get_file_extension(file_path)
            os_tuples.append((path, name, ext))
    logger.info(f"Found {len(os_tuples)} files in target directory")
    return os_tuples


def calculate_md5(file: bytes) -> str:
    # 读取文件的内容并计算 md5 值。
    md5 = hashlib.sha256()
    md5.update(file)
    return md5.hexdigest()


def create_thumbnail(input_image_path: Path, output_image_path: Path, max_width: int = 400):
    with Image.open(input_image_path) as img:
        create_thumbnail_by_image(img, output_image_path, max_width)


def create_thumbnail_by_image(img: Image.Image, output_image_path: Path, max_width: int = 400):
    width, height = img.size
    if width > max_width:
        new_width = max_width
        new_height = int((new_width / width) * height)
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    img.save(output_image_path)


def get_path_name_and_extension(file_path: Path) -> tuple[str, str, str]:
    # 如果是绝对路径，则将其转换为相对路径，相对于target_dir
    basic_path = file_path.relative_to(shared.target_dir) if file_path.is_absolute() else file_path

    path = basic_path.parent.as_posix()
    name = basic_path.stem  # 不包含扩展名的文件名
    ext = file_path.suffix[1:]  # 扩展名（不含点）

    return path, name, ext


def update_file_metadata(file_data: bytes, post: Post, file_abs_path: Path):
    post.md5 = calculate_md5(file_data)
    post.size = file_abs_path.stat().st_size

    # 从 file_path 获取所有上级目录，存到列表里
    # folder = str(Path(post.file_path).parents[0]).replace("\\", "/")

    # # 查询 Folder 表，如果不存在则创建
    # folder_record = session.query(Folder).filter(Folder.path == folder).first()
    # if folder_record is None:
    #     folder_record = Folder(path=folder, file_count=0)
    #     session.add(folder_record)
    # folder_record.file_count += 1


def compute_image_properties(img: Image.Image, post: Post, file_abs_path: Path):
    img.verify()
    post.width, post.height = img.size
    relative_path = file_abs_path.relative_to(shared.target_dir)
    thumbnails_path = shared.thumbnails_dir / relative_path
    if not thumbnails_path.exists():
        thumbnails_path.parent.mkdir(parents=True, exist_ok=True)
        create_thumbnail(
            file_abs_path,
            thumbnails_path,
        )


def remove_post(
    session: Session,
    file_abs_path: Path | None = None,
    post: Post | None = None,
    *,
    auto_commit: bool = True,
):
    if post is None:
        file_path, file_name, extension = get_path_name_and_extension(file_abs_path)
        post = session.query(Post).filter(Post.file_path == file_path, Post.file_name == file_name, Post.extension == extension).first()
    else:
        file_abs_path = shared.target_dir / post.file_path
        file_abs_path = file_abs_path.with_suffix(f".{post.extension}")
    if post is None:
        logger.info(f"Post not found in database: {file_abs_path}")
        return
    logger.info(f"Removing post: {post.file_path}.{post.extension}")
    if not file_abs_path:
        return
    relative_path = file_abs_path.relative_to(shared.target_dir)
    thumbnails_path = shared.thumbnails_dir / relative_path
    if thumbnails_path.exists():
        thumbnails_path.unlink()
        logger.info(f"Removed thumbnail: {thumbnails_path}")
    session.delete(post)
    if auto_commit:
        session.commit()
    logger.info(f"Removed post from database: {file_abs_path}")


def remove_post_in_path(session: Session, file_path: Path):
    # 如果 file_path 是绝对路径，则转换为相对路径
    if file_path.is_absolute():
        file_path = file_path.relative_to(shared.target_dir)
    file_path = str(file_path).replace("\\", "/")
    # 删除数据库中前缀和 file_path 相同的所有文件
    posts = session.query(Post).filter(Post.file_path.like(f"{file_path}%")).all()
    for post in posts:
        remove_post(session, post=post, auto_commit=False)
    session.commit()


def from_rating_to_int(rating: str) -> int:
    # sourcery skip: assign-if-exp, reintroduce-else
    """
    0: Not Rated
    1: general
    2. sensitive
    3: questionable
    4: explicit
    """
    if rating == "general":
        return 1
    if rating == "sensitive":
        return 2
    if rating == "questionable":
        return 3
    if rating == "explicit":
        return 4
    return 0


async def attach_tags_to_posts(session: AsyncSession, post: list[Post], resp: list[wdtagger.Result], *, is_auto: bool = False):
    # Bulk process all posts and responses together for better efficiency
    all_tag_names = set()
    tag_groups = {
        "general": {"names": [], "color": "#006192"},
        "character": {"names": [], "color": "#8243ca"},
        "artist": {"names": [], "color": "#f30000"},
        "copyright": {"names": [], "color": "#00b300"},
    }

    # Collect all tags from all responses
    for result in resp:
        all_tag_names.update(result.general_tags)
        all_tag_names.update(result.character_tags)
        tag_groups["general"]["names"].extend(result.general_tags)
        tag_groups["character"]["names"].extend(result.character_tags)

    # Fetch all tag groups in a single query
    group_names = list(tag_groups.keys())
    existing_groups = (await session.scalars(select(TagGroup).where(TagGroup.name.in_(group_names)))).all()
    existing_group_dict = {group.name: group for group in existing_groups}

    # Create missing groups
    for tag_group_name, group_info in tag_groups.items():
        if tag_group_name not in existing_group_dict:
            tag_group = TagGroup(name=tag_group_name, color=group_info["color"])
            session.add(tag_group)
            existing_group_dict[tag_group_name] = tag_group

    # Fetch all existing tags in one query
    existing_tags = (await session.scalars(select(Tag).where(Tag.name.in_(all_tag_names)))).all()
    existing_tag_dict = {tag.name: tag for tag in existing_tags}

    # Fetch all existing post-tag relationships
    post_ids = [p.id for p in post]
    existing_post_tags = (await session.scalars(select(PostHasTag).where((PostHasTag.post_id.in_(post_ids)) & (PostHasTag.tag_name.in_(all_tag_names))))).all()

    # Create lookup dict for existing post-tag relationships
    post_tag_map = {(pt.post_id, pt.tag_name): pt for pt in existing_post_tags}

    # Process tags and create any missing tags
    for tag_name in all_tag_names:
        if tag_name in tag_groups["general"]["names"]:
            group_name = "general"
        elif tag_name in tag_groups["character"]["names"]:
            group_name = "character"
        else:
            continue  # Skip if not in any group

        tag_group = existing_group_dict[group_name]

        # Update or create tag
        if tag_name in existing_tag_dict:
            tag = existing_tag_dict[tag_name]
            if not tag.group_id:
                tag.group_id = tag_group.id
                session.add(tag)
        else:
            tag = Tag(name=tag_name, group_id=tag_group.id)
            session.add(tag)
            existing_tag_dict[tag_name] = tag

    # Link tags to posts
    for p, r in zip(post, resp, strict=False):
        for tag_name in r.general_tags + r.character_tags:
            if (p.id, tag_name) not in post_tag_map:
                post_has_tag = PostHasTag(post_id=p.id, tag_name=tag_name, is_auto=is_auto)
                p.tags.append(post_has_tag)
        session.add(p)


async def attach_tags_to_post(session: AsyncSession, post: Post, resp: wdtagger.Result, *, is_auto: bool = False):
    attach_tags_to_posts(session, [post], [resp], is_auto=is_auto)


@cache
def _get_tagger() -> wdtagger.Tagger:
    return wdtagger.Tagger(model_repo="SmilingWolf/wd-vit-large-tagger-v3")


lock = threading.Lock()


def get_tagger():
    with lock:
        return _get_tagger()
