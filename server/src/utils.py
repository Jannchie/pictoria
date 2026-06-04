"""Pure utilities: file walking, hashing, thumbnails, small converters.

Startup assembly lives in ``bootstrap``; WDTagger persistence in
``services.wd_tagging``.
"""

import base64
import hashlib
import os
import warnings
from pathlib import Path

from arthash import Codec
from arthash import encode as arthash_encode
from PIL import Image, ImageFile

import shared
from shared import logger

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

_DirScanCache = dict[str, tuple[int, list[tuple[str, str, str]]]]


def find_files_in_directory(  # noqa: C901, PLR0915
    target_dir: Path,
    cache: _DirScanCache | None = None,
) -> list[tuple[str, str, str]]:
    """Walk ``target_dir`` and return (relative_path, stem, extension) tuples.

    Uses ``os.scandir`` recursively because ``Path.rglob`` allocates a Path
    object per entry and re-stats every node — when the target has 100k+
    files that becomes the dominant cost (we measured ~1 minute for 155k
    files; scandir does the same scan in seconds because DirEntry already
    caches the type from the directory listing).

    Skips any top-level entry whose name starts with ``.`` (e.g. the
    ``.pictoria`` working dir).

    When ``cache`` is provided, each directory's direct file list is keyed by
    absolute path → ``(mtime_ns, files_in_dir)``. A directory whose mtime
    matches its cache entry skips the ``scandir`` of its direct files (we
    still recurse into subdirectories to pick up changes deeper in the tree,
    since on NTFS / ext4 a parent dir's mtime only reflects direct entries).
    The poller in app.py runs this every minute on a 150k-file library, so
    this turns most polls into a sub-second tree walk.
    """
    os_tuples: list[tuple[str, str, str]] = []

    def _split_name(name: str) -> tuple[str, str]:
        dot = name.rfind(".")
        if dot > 0:
            return name[:dot], name[dot + 1:]
        return name, ""

    def _walk(dir_path: str, rel_dir: str, *, is_top: bool = False) -> None:  # noqa: C901, PLR0912
        try:
            cur_mtime_ns = os.stat(dir_path).st_mtime_ns  # noqa: PTH116
        except OSError as exc:
            logger.warning(f"Skipping {dir_path}: {exc}")
            return

        cached = cache.get(dir_path) if cache is not None else None
        subdirs: list[tuple[str, str]] = []
        if cached is not None and cached[0] == cur_mtime_ns:
            # Reuse the cached direct-file listing; we still need to walk
            # subdirectories because their contents may have changed without
            # bumping our mtime.
            os_tuples.extend(cached[1])
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
                            subdirs.append((entry.path, sub_rel))
                    except OSError as exc:
                        logger.debug(f"Skipping {entry.path}: {exc}")
        else:
            try:
                it = os.scandir(dir_path)
            except OSError as exc:
                logger.warning(f"Skipping {dir_path}: {exc}")
                return
            direct_files: list[tuple[str, str, str]] = []
            with it:
                for entry in it:
                    if is_top and entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            sub_rel = entry.name if rel_dir == "." else f"{rel_dir}/{entry.name}"
                            subdirs.append((entry.path, sub_rel))
                        elif entry.is_file(follow_symlinks=False):
                            stem, ext = _split_name(entry.name)
                            direct_files.append((rel_dir, stem, ext))
                    except OSError as exc:
                        logger.debug(f"Skipping {entry.path}: {exc}")
            os_tuples.extend(direct_files)
            if cache is not None:
                cache[dir_path] = (cur_mtime_ns, direct_files)

        for sub_path, sub_rel in subdirs:
            _walk(sub_path, sub_rel)

    _walk(str(target_dir), ".", is_top=True)

    logger.info(f"Found {len(os_tuples)} files in target directory")
    return os_tuples


def calculate_sha256(file: bytes) -> str:
    sha256 = hashlib.sha256()
    sha256.update(file)
    return sha256.hexdigest()


# Placeholder-image codec for posts. RECT/n=32 produces a ~180-byte hash
# that decodes to a 33-element rectangle mosaic — abstract enough to read
# as a placeholder, detailed enough to hint at the image's layout, and
# cheap enough on the frontend to animate 50+ tiles at once. Must match
# the codec the frontend uses to decode (see web/src/utils/arthash.ts).
ARTHASH_CODEC = Codec.rect(n=32)


def calculate_arthash(source: Path | Image.Image) -> str | None:
    try:
        hash_bytes = arthash_encode(source, ARTHASH_CODEC)
        return base64.b64encode(bytes(hash_bytes)).decode("ascii")
    except Exception as exc:
        logger.warning(f"Failed to generate arthash for {source!r}: {exc}")
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


def resolve_source(raw_source: str | None, fallback_url: str) -> str:
    """Prefer the metadata-registered original source; fall back to the site page.

    Booru/Danbooru leave an empty string when a post has no upstream source, so
    `or` correctly routes both "" and None to the fallback.
    """
    return raw_source or fallback_url
