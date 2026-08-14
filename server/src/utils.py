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


def from_rating_to_int(rating: str) -> int:
    """0=Not Rated, 1=general, 2=sensitive, 3=questionable, 4=explicit."""
    return {"general": 1, "sensitive": 2, "questionable": 3, "explicit": 4}.get(rating, 0)


def resolve_source(raw_source: str | None, fallback_url: str) -> str:
    """Prefer the metadata-registered original source; fall back to the site page.

    Booru/Danbooru leave an empty string when a post has no upstream source, so
    `or` correctly routes both "" and None to the fallback.
    """
    return raw_source or fallback_url
