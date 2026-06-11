import asyncio
import mimetypes
from pathlib import Path
from typing import ClassVar

import httpx
from litestar import Controller, Response, get
from litestar.datastructures import CacheControlHeader
from litestar.exceptions import NotFoundException
from litestar.response import File
from litestar.status_codes import HTTP_200_OK
from PIL import UnidentifiedImageError

import shared
from db.repositories.posts import PostRepo
from services.s3 import presigned_get_object_from_s3
from shared import logger
from utils import create_thumbnail

# Frontend image URLs are content-addressed via a `?hash=<sha256>` query, so
# a given URL maps to exactly one byte sequence forever. `immutable` lets the
# browser skip even revalidation on re-mount (huge win for virtualized
# Waterfall scrolling that unmounts/remounts tiles as they leave/re-enter
# the viewport).
_IMAGE_CACHE = CacheControlHeader(
    max_age=60 * 60 * 24 * 30,  # 30 days
    public=True,
    immutable=True,
)

mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/jpeg", ".jpeg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/gif", ".gif")
mimetypes.add_type("image/bmp", ".bmp")
mimetypes.add_type("image/tiff", ".tiff")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/vnd.microsoft.icon", ".ico")
mimetypes.add_type("image/heic", ".heic")
mimetypes.add_type("image/heif", ".heif")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("image/x-icon", ".ico")


def _resolve_inside(base: Path, post_path: str) -> Path:
    """Join a client-supplied ``{post_path:path}`` onto ``base``, safely.

    The raw parameter can contain ``..`` segments (the ASGI server percent-
    decodes them after any client-side normalization), so a plain join could
    escape the library root and serve arbitrary files. Resolve and require the
    result to stay inside ``base``; reject anything else as not-found.
    """
    candidate = (base / post_path.lstrip("/")).resolve()
    if not candidate.is_relative_to(base.resolve()):
        raise NotFoundException(detail="Image not found")
    return candidate


async def _create_thumbnail_or_404(original: Path, thumbnail: Path) -> None:
    """Build a thumbnail, translating an undecodable original into a 404.

    A 0-byte or otherwise corrupt original makes PIL raise
    ``UnidentifiedImageError`` (or ``OSError`` for truncated files). That is a
    data condition, not a server fault, so surface it as "not found" rather
    than letting it bubble up as an unhandled 500.
    """
    try:
        await asyncio.to_thread(create_thumbnail, original, thumbnail)
    except (UnidentifiedImageError, OSError) as exc:
        logger.warning(f"Cannot create thumbnail for {original}: {exc}")
        raise NotFoundException(detail="Image cannot be decoded for thumbnail") from exc


class ImageController(Controller):
    path = "/images"
    tags: ClassVar[list[str]] = ["Images"]  # type: ignore

    @get("/original/{post_path:path}", cache_control=_IMAGE_CACHE)
    async def get_original(self, post_path: str) -> File:
        """Get original image by file path."""
        abs_path = _resolve_inside(shared.target_dir, post_path)
        if not abs_path.exists():
            raise NotFoundException(detail="Original image not found")
        media_type, _ = mimetypes.guess_type(abs_path)
        return File(abs_path, media_type=media_type, filename=abs_path.name, content_disposition_type="inline")

    @get("/thumbnails/{post_path:path}", cache_control=_IMAGE_CACHE)
    async def get_thumbnail(self, post_path: str) -> File:
        """Get thumbnail image by file path (creates one if missing)."""
        thumbnail_file_path = _resolve_inside(shared.thumbnails_dir, post_path)
        original_file_path = _resolve_inside(shared.target_dir, post_path)
        if not original_file_path.exists():
            raise NotFoundException(detail="Original image not found")
        thumbnail_file_path.parent.mkdir(parents=True, exist_ok=True)
        if not thumbnail_file_path.exists():
            await _create_thumbnail_or_404(original_file_path, thumbnail_file_path)
        media_type, _ = mimetypes.guess_type(thumbnail_file_path)
        return File(thumbnail_file_path, media_type=media_type, filename=thumbnail_file_path.name, content_disposition_type="inline")

    @get("/original/id/{post_id:int}", cache_control=_IMAGE_CACHE)
    async def get_original_by_id(self, post_id: int, posts: PostRepo) -> File | Response:
        """Get original image by post id, falling back to S3 if missing locally."""
        post = await posts.get(post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found")

        abs_path = post.absolute_path
        media_type, _ = mimetypes.guess_type(abs_path)
        if not abs_path.exists():
            # Never delete the post from a read path: a missing presigned link
            # or a non-200 from S3 is routinely transient (unconfigured S3,
            # throttling, network blip, clock-skewed 403). Treating it as proof
            # the image is gone mass-deleted posts during outages. Truly stale
            # rows are reconciled by the metadata sync, not by GETs.
            link = await presigned_get_object_from_s3(post.full_path)
            if not link:
                raise NotFoundException(detail=f"Original image for post {post_id} not found")
            async with httpx.AsyncClient() as client:
                response = await client.get(link)
                if response.status_code != HTTP_200_OK:
                    logger.warning(f"S3 fallback for post {post_id} returned {response.status_code}")
                    raise NotFoundException(detail=f"Failed to download original image for post {post_id}")
                return Response(response.content, media_type=media_type)
        return File(abs_path, media_type=media_type, filename=abs_path.name, content_disposition_type="inline")

    @get("/thumbnails/id/{post_id:int}", cache_control=_IMAGE_CACHE)
    async def get_thumbnail_by_id(self, post_id: int, posts: PostRepo) -> File:
        """Get thumbnail image by post id (creates one if missing)."""
        post = await posts.get(post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found")

        original_file_path = post.absolute_path
        if not original_file_path.exists():
            raise NotFoundException(detail=f"Original image for post {post_id} not found")

        thumbnail_file_path = post.thumbnail_path
        thumbnail_file_path.parent.mkdir(parents=True, exist_ok=True)
        if not thumbnail_file_path.exists():
            await _create_thumbnail_or_404(original_file_path, thumbnail_file_path)

        media_type, _ = mimetypes.guess_type(thumbnail_file_path)
        return File(thumbnail_file_path, media_type=media_type, filename=thumbnail_file_path.name, content_disposition_type="inline")
