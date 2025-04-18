import mimetypes
from typing import ClassVar

from litestar import Controller, get
from litestar.exceptions import NotFoundException
from litestar.response import File

import shared
from utils import create_thumbnail

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


class ImageController(Controller):
    """
    Controller for image-related endpoints.
    Handles requests for original and thumbnail images.
    Provides methods to retrieve images based on their paths.
    """

    path = "/images"
    tags: ClassVar[list[str]] = ["Images"]

    @get("/original/{post_path:path}")
    async def get_original(self, post_path: str) -> File:
        """
        Get original image.
        """
        abs_path = shared.target_dir / post_path[post_path.rfind("/") + 1 :]
        if not abs_path.exists():
            raise NotFoundException(detail="Original image not found")
        media_type, _ = mimetypes.guess_type(abs_path)
        return File(abs_path, media_type=media_type)

    @get("/thumbnails/{post_path:path}")
    async def get_thumbnail(self, post_path: str) -> File:
        """
        Get thumbnail image.
        """
        thumbnail_file_path = shared.thumbnails_dir / post_path[post_path.rfind("/") + 1 :]
        if not thumbnail_file_path.exists():
            thumbnail_file_path.parent.mkdir(parents=True, exist_ok=True)
        original_file_path = shared.target_dir / post_path[post_path.rfind("/") + 1 :]
        if not original_file_path.exists():
            raise NotFoundException(detail="Original image not found")
        if not thumbnail_file_path.exists():
            create_thumbnail(original_file_path, thumbnail_file_path)
        media_type, _ = mimetypes.guess_type(thumbnail_file_path)
        return File(thumbnail_file_path, media_type=media_type)
