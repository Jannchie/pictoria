"""Pure utilities: hashing, arthash, thumbnails, small converters.

File walking moved to the TS side (`apps/api/src/sync.ts`) and WDTagger
persistence with it; what is left here is called from the cairnq handlers.
"""

import base64
import hashlib
import warnings
from pathlib import Path

from arthash import Codec
from arthash import encode as arthash_encode
from PIL import Image, ImageFile

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


def _thumbnail_size(size: tuple[int, int], max_width: int) -> tuple[int, int] | None:
    """The thumbnail's size for an image of ``size``, or None when it is narrow enough."""
    width, height = size
    if width <= max_width:
        return None
    return max_width, int((max_width / width) * height)


def create_thumbnail(input_image_path: Path, output_image_path: Path, max_width: int = 400):
    """The on-demand thumbnail (``handle_thumbnail``), decoding no more than it needs.

    A JPEG is asked for a DCT-scaled decode (``draft``) at no less than twice the
    target: libjpeg then skips most of the work for a 6000 px original, and the
    LANCZOS pass still has 2x the pixels to filter from. ``draft`` rounds the
    scaled size up, so the target is computed from the **original** size first —
    the output dimensions are exactly what a full decode would have produced.

    basics does not come through here: it decodes once for the arthash and the
    palette as well, and those want the full image.
    """
    with Image.open(input_image_path) as img:
        target = _thumbnail_size(img.size, max_width)
        if target is not None and img.format == "JPEG":
            img.draft("RGB", (max_width * 2, max_width * 2))
        _save_thumbnail(img, output_image_path, target)


def create_thumbnail_by_image(img: Image.Image, output_image_path: Path, max_width: int = 400):
    _save_thumbnail(img, output_image_path, _thumbnail_size(img.size, max_width))


def _save_thumbnail(img: Image.Image, output_image_path: Path, target: tuple[int, int] | None) -> None:
    if target is not None:
        img = img.resize(target, Image.Resampling.LANCZOS)
    img.save(output_image_path)


#: File extensions an importer keeps. Anything else in a listing (videos, zips,
#: ugoira) can never become a post, so the importers skip it before download.
SUPPORTED_IMAGE_EXTS: frozenset[str] = frozenset(
    {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"},
)

#: ``posts.rating``: 0 = not rated, then general / sensitive / questionable /
#: explicit. Spelled-out form (gallery-dl's full-word ratings).
_RATING_WORDS: dict[str, int] = {"general": 1, "sensitive": 2, "questionable": 3, "explicit": 4}

#: The one-letter booru form: the Danbooru API's ``rating``, gallery-dl's booru
#: metadata, the danbooru2026 archive. moebooru (yande.re / konachan) uses
#: ``s`` for *safe*; it lands on sensitive here -- a harmless over-tag.
_RATING_LETTERS: dict[str, int] = {"g": 1, "s": 2, "q": 3, "e": 4}


def rating_to_int(raw: object) -> int:
    """Any upstream rating spelling -> the ``posts.rating`` int (0 when unknown).

    The single Python copy of this map. It used to exist three times, and the
    word-only one silently sent the Danbooru API's one-letter ratings to 0.
    """
    if not isinstance(raw, str) or not raw:
        return 0
    key = raw.lower()
    return (_RATING_LETTERS if len(key) == 1 else _RATING_WORDS).get(key, 0)


def resolve_source(raw_source: str | None, fallback_url: str) -> str:
    """Prefer the metadata-registered original source; fall back to the site page.

    Booru/Danbooru leave an empty string when a post has no upstream source, so
    `or` correctly routes both "" and None to the fallback.
    """
    return raw_source or fallback_url
