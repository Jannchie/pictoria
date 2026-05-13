import argparse
import asyncio
import base64
import hashlib
import os
import sys
import threading
import time
import warnings
from collections.abc import Callable
from functools import cache, wraps
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

import thash
from dotenv import load_dotenv
from PIL import Image

import shared
from shared import logger

if TYPE_CHECKING:
    import wdtagger

    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo

# PIL emits a UserWarning ("Corrupt EXIF data. Expecting to read N bytes but
# only got M") when a JPEG/TIFF has a malformed EXIF block. PIL recovers and
# decodes the image fine, so this is pure log noise; suppress it.
warnings.filterwarnings("ignore", message="Corrupt EXIF data", category=UserWarning)

# PIL's decompression-bomb protection caps single-image pixel count at ~178M
# pixels (~13k x 13k) and raises `Image.DecompressionBombError` past that.
# That's a sensible default for servers that ingest untrusted uploads, but
# this app is a personal gallery managing the user's own files — large
# illustrations and scans (16k+) are routine. Disable the cap.
Image.MAX_IMAGE_PIXELS = None

load_dotenv()

R = TypeVar("R")


def timer(func: Callable[..., R]) -> Callable[..., R]:
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> R:
        start_time = time.time()
        result = func(*args, **kwargs)
        end_time = time.time()
        logger.info(f"Function '{func.__name__}' executed in: {end_time - start_time:.4f} seconds")
        return result

    return wrapper


def prepare_s3() -> None:
    shared.s3_endpoint = os.environ.get("S3_ENDPOINT")
    shared.s3_access_key = os.environ.get("S3_ACCESS_KEY")
    shared.s3_secret_key = os.environ.get("S3_SECRET_KEY")
    shared.s3_bucket = os.environ.get("S3_BUCKET", "pictoria")
    shared.s3_base_dir = os.environ.get("S3_BASE_DIR", "collections")


def initialize(target_dir: os.PathLike, openai_key: str | None = None) -> None:
    prepare_paths(Path(target_dir))
    prepare_openai_api(openai_key)
    prepare_s3()
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


def calculate_sha256(file: bytes) -> str:
    sha256 = hashlib.sha256()
    sha256.update(file)
    return sha256.hexdigest()


def calculate_thumbhash(file_path: Path) -> str | None:
    try:
        thumb_hash = thash.image_to_thumb_hash(file_path)
        return base64.b64encode(bytes(thumb_hash)).decode("ascii")
    except Exception as exc:
        logger.warning(f"Failed to generate thumbhash for {file_path}: {exc}")
        return None


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
    basic_path = file_path.relative_to(shared.target_dir) if file_path.is_absolute() else file_path
    path = basic_path.parent.as_posix()
    name = basic_path.stem
    ext = file_path.suffix[1:]
    return path, name, ext


def from_rating_to_int(rating: str) -> int:
    """0=Not Rated, 1=general, 2=sensitive, 3=questionable, 4=explicit."""
    return {"general": 1, "sensitive": 2, "questionable": 3, "explicit": 4}.get(rating, 0)


TAG_GROUP_COLORS: dict[str, str] = {
    "general":   "#006192",
    "character": "#8243ca",
    "artist":    "#f30000",
    "copyright": "#00b300",
}


# ─── wdtagger result attachment ────────────────────────────────────────
async def attach_wdtagger_results(
    posts: "PostRepo",
    tag_groups: "TagGroupRepo",
    post_id: int,
    result: "wdtagger.Result",
    *,
    is_auto: bool = False,
) -> None:
    """Persist wdtagger output for a single post.

    Creates missing tag groups (general/character) and missing tags, then
    links them via post_has_tag.
    """
    # Ensure canonical groups exist
    group_objs: dict[str, int] = {}
    for group_name, color in TAG_GROUP_COLORS.items():
        g = await tag_groups.ensure(group_name, color=color)
        group_objs[group_name] = g.id

    def _persist_tags() -> None:
        cur = posts.cur
        # Bulk handle general + character tags
        general_set = set(result.general_tags)
        character_set = set(result.character_tags)
        all_names = list(general_set | character_set)
        if not all_names:
            return

        # Insert any missing tag rows with their group_id
        for name in general_set:
            cur.execute(
                "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE "
                "SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END",
                [name, group_objs["general"]],
            )
        for name in character_set:
            cur.execute(
                "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE "
                "SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END",
                [name, group_objs["character"]],
            )
        # Link to post (idempotent)
        for name in all_names:
            cur.execute(
                "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?) "
                "ON CONFLICT (post_id, tag_name) DO NOTHING",
                [post_id, name, is_auto],
            )

    await asyncio.to_thread(_persist_tags)


# ─── wdtagger model loader (lazy) ──────────────────────────────────────
@cache
def _get_tagger() -> "wdtagger.Tagger":
    import wdtagger  # noqa: PLC0415  # lazy: defer ML stack load until first use
    return wdtagger.Tagger(model_repo="SmilingWolf/wd-vit-large-tagger-v3")


_tagger_lock = threading.Lock()


def get_tagger():
    with _tagger_lock:
        return _get_tagger()
