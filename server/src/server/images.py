import mimetypes
from typing import ClassVar

import httpx
from litestar import Controller, Response, get
from litestar.exceptions import NotFoundException
from litestar.response import File
from litestar.status_codes import HTTP_200_OK
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from models import Post
from services.s3 import presigned_get_object_from_s3
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


async def delete_post_by_id(session: AsyncSession, post_id: int) -> None:
    """
    Deletes a post by its ID.
    If the post does not exist, it raises a NotFoundException.
    """
    await session.execute(text("DELETE FROM posts WHERE id = :post_id"), {"post_id": post_id})
    await session.commit()


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
        abs_path = shared.target_dir / post_path[1:]
        if not abs_path.exists():
            raise NotFoundException(detail="Original image not found")
        media_type, _ = mimetypes.guess_type(abs_path)
        return File(abs_path, media_type=media_type, filename=abs_path.name, content_disposition_type="inline")

    @get("/thumbnails/{post_path:path}")
    async def get_thumbnail(self, post_path: str) -> File:
        """
        Get thumbnail image.
        """
        thumbnail_file_path = shared.thumbnails_dir / post_path[1:]
        if not thumbnail_file_path.exists():
            thumbnail_file_path.parent.mkdir(parents=True, exist_ok=True)
        original_file_path = shared.target_dir / post_path[1:]
        if not original_file_path.exists():
            raise NotFoundException(detail="Original image not found")
        if not thumbnail_file_path.exists():
            create_thumbnail(original_file_path, thumbnail_file_path)
        media_type, _ = mimetypes.guess_type(thumbnail_file_path)
        return File(thumbnail_file_path, media_type=media_type, filename=thumbnail_file_path.name, content_disposition_type="inline")

    @get("/original/id/{post_id:int}")
    async def get_original_by_id(self, post_id: int, session: AsyncSession) -> File:
        """
        Get original image by id.
        """
        post = await session.get(Post, post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found")

        abs_path = post.absolute_path
        media_type, _ = mimetypes.guess_type(abs_path)
        if not abs_path.exists():
            link = await presigned_get_object_from_s3(post.full_path)
            # download the file by link, and return it
            if not link:
                await delete_post_by_id(session, post_id)
                raise NotFoundException(detail=f"Original image for post {post_id} not found")

            async with httpx.AsyncClient() as client:
                response = await client.get(link)

                if response.status_code != HTTP_200_OK:
                    await delete_post_by_id(session, post_id)
                    raise NotFoundException(detail=f"Failed to download original image for post {post_id}")

                return Response(
                    response.content,
                    media_type=media_type,
                )
        return File(abs_path, media_type=media_type, filename=abs_path.name, content_disposition_type="inline")

    @get("/thumbnails/id/{post_id:int}")
    async def get_thumbnail_by_id(self, post_id: int, session: AsyncSession) -> File:
        """
        Get thumbnail image by id.
        """
        post = await session.get(Post, post_id)
        if not post:
            raise NotFoundException(detail=f"Post with id {post_id} not found")

        thumbnail_file_path = post.thumbnail_path
        if not thumbnail_file_path.exists():
            thumbnail_file_path.parent.mkdir(parents=True, exist_ok=True)

        original_file_path = post.absolute_path
        if not original_file_path.exists():
            raise NotFoundException(detail=f"Original image for post {post_id} not found")

        if not thumbnail_file_path.exists():
            create_thumbnail(original_file_path, thumbnail_file_path)

        media_type, _ = mimetypes.guess_type(thumbnail_file_path)
        return File(thumbnail_file_path, media_type=media_type, filename=thumbnail_file_path.name, content_disposition_type="inline")
