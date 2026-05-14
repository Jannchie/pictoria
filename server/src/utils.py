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
from PIL import Image, ImageFile

import shared
from shared import logger

if TYPE_CHECKING:
    import sqlite3

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

# Allow loading partially-downloaded / interrupted images. Without this, PIL
# raises OSError("Truncated File Read") and the post is permanently stuck in
# the basics/embedding/tagger/waifu backlog. Personal-gallery semantics: do
# the best we can with whatever bytes survived.
ImageFile.LOAD_TRUNCATED_IMAGES = True

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
    """Walk ``target_dir`` and return (relative_path, stem, extension) tuples.

    Uses ``os.scandir`` recursively because ``Path.rglob`` allocates a Path
    object per entry and re-stats every node — when the target has 100k+
    files that becomes the dominant cost (we measured ~1 minute for 155k
    files; scandir does the same scan in seconds because DirEntry already
    caches the type from the directory listing).

    Skips any top-level entry whose name starts with ``.`` (e.g. the
    ``.pictoria`` working dir).
    """
    os_tuples: list[tuple[str, str, str]] = []

    def _split_name(name: str) -> tuple[str, str]:
        dot = name.rfind(".")
        if dot > 0:
            return name[:dot], name[dot + 1:]
        return name, ""

    def _walk(dir_path: str, rel_dir: str, *, is_top: bool = False) -> None:
        try:
            it = os.scandir(dir_path)
        except OSError as exc:
            logger.warning(f"Skipping {dir_path}: {exc}")
            return
        with it:
            for entry in it:
                if is_top and entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        sub_rel = entry.name if rel_dir == "." else f"{rel_dir}/{entry.name}"
                        _walk(entry.path, sub_rel)
                    elif entry.is_file(follow_symlinks=False):
                        stem, ext = _split_name(entry.name)
                        os_tuples.append((rel_dir, stem, ext))
                except OSError as exc:
                    logger.debug(f"Skipping {entry.path}: {exc}")

    _walk(str(target_dir), ".", is_top=True)

    logger.info(f"Found {len(os_tuples)} files in target directory")
    return os_tuples


def calculate_sha256(file: bytes) -> str:
    sha256 = hashlib.sha256()
    sha256.update(file)
    return sha256.hexdigest()


def calculate_thumbhash(source: Path | Image.Image) -> str | None:
    try:
        thumb_hash = thash.encode(source)
        return base64.b64encode(bytes(thumb_hash)).decode("ascii")
    except Exception as exc:
        logger.warning(f"Failed to generate thumbhash for {source!r}: {exc}")
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
    """Persist wdtagger output for a single post."""
    group_objs = await _resolve_canonical_tag_groups(tag_groups)
    await asyncio.to_thread(_persist_wdtagger_results, posts.cur, post_id, result, group_objs, is_auto)


async def attach_wdtagger_results_many(
    posts: "PostRepo",
    tag_groups: "TagGroupRepo",
    items: list[tuple[int, "wdtagger.Result"]],
    *,
    is_auto: bool = False,
) -> None:
    """Persist wdtagger output for a batch of posts in a single DB round-trip.

    Equivalent to calling :func:`attach_wdtagger_results` once per item, but
    folds all the per-row ``INSERT`` calls into three ``executemany`` calls so
    the batch only crosses the asyncio→thread boundary once.
    """
    if not items:
        return
    group_objs = await _resolve_canonical_tag_groups(tag_groups)
    await asyncio.to_thread(_persist_wdtagger_results_many, posts.cur, items, group_objs, is_auto)


async def _resolve_canonical_tag_groups(tag_groups: "TagGroupRepo") -> dict[str, int]:
    """Return ``{group_name: id}`` for the four canonical groups.

    On startup ``shared.canonical_tag_groups`` is filled once by
    ``ensure_canonical_tag_groups_sync``; this fast-path skips the per-image
    ``ensure`` round-trips (4 SQL ops x every post in the library) that used
    to dominate tagger backfill time. Falls back to ``ensure`` if the cache
    is empty (single-image upload before startup populated the cache, tests,
    etc.).
    """
    cached = shared.canonical_tag_groups
    if cached and all(name in cached for name in TAG_GROUP_COLORS):
        return cached
    group_objs: dict[str, int] = {}
    for group_name, color in TAG_GROUP_COLORS.items():
        g = await tag_groups.ensure(group_name, color=color)
        group_objs[group_name] = g.id
    return group_objs


def _persist_wdtagger_results(
    cur: "sqlite3.Cursor",
    post_id: int,
    result: "wdtagger.Result",
    group_objs: dict[str, int],
    is_auto: bool,  # noqa: FBT001  # internal helper, keyword-only would force every caller to spell it
) -> None:
    general_set = set(result.general_tags)
    character_set = set(result.character_tags)
    all_names = general_set | character_set
    if not all_names:
        return

    _executemany_tag_upsert(cur, general_set, group_objs["general"])
    _executemany_tag_upsert(cur, character_set, group_objs["character"])
    cur.executemany(
        "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?) "
        "ON CONFLICT (post_id, tag_name) DO NOTHING",
        [(post_id, name, is_auto) for name in all_names],
    )


def _persist_wdtagger_results_many(
    cur: "sqlite3.Cursor",
    items: list[tuple[int, "wdtagger.Result"]],
    group_objs: dict[str, int],
    is_auto: bool,  # noqa: FBT001  # mirrors public attach_wdtagger_results_many signature
) -> None:
    # Deduplicate tag names across the whole batch so the upsert only touches
    # each tag once even if many images share it.
    general_seen: set[str] = set()
    character_seen: set[str] = set()
    link_rows: list[tuple[int, str, bool]] = []
    for post_id, result in items:
        general_set = set(result.general_tags)
        character_set = set(result.character_tags)
        general_seen |= general_set
        character_seen |= character_set
        link_rows.extend((post_id, name, is_auto) for name in general_set | character_set)
    if not link_rows:
        return

    _executemany_tag_upsert(cur, general_seen, group_objs["general"])
    _executemany_tag_upsert(cur, character_seen, group_objs["character"])
    cur.executemany(
        "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?) "
        "ON CONFLICT (post_id, tag_name) DO NOTHING",
        link_rows,
    )


def _executemany_tag_upsert(cur: "sqlite3.Cursor", names: set[str], group_id: int) -> None:
    if not names:
        return
    cur.executemany(
        "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT (name) DO UPDATE "
        "SET group_id = CASE WHEN tags.group_id IS NULL THEN excluded.group_id ELSE tags.group_id END",
        [(name, group_id) for name in names],
    )


# ─── wdtagger model loader (lazy) ──────────────────────────────────────
@cache
def _get_tagger() -> "wdtagger.Tagger":
    import wdtagger  # noqa: PLC0415  # lazy: defer ML stack load until first use
    return wdtagger.Tagger(model_repo="SmilingWolf/wd-vit-large-tagger-v3")


_tagger_lock = threading.Lock()


def get_tagger():
    with _tagger_lock:
        return _get_tagger()
