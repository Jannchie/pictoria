"""Turn an upload (a multipart file *or* a remote URL) into a stored post.

This is the workflow that used to live inline in ``PostController.upload_file``:
deciding the byte source, resolving the on-disk path, persisting the row, writing
the file and kicking off the backfill. Lifting it behind one ``store`` call keeps
the HTTP handler thin and lets the workflow be exercised without an HTTP request
(the byte-fetch, path resolution and dedup checks are the parts that actually
carry bugs).
"""

from __future__ import annotations

import asyncio
import io
import shutil
from typing import TYPE_CHECKING

import httpx

import shared
from server.exceptions import FileAlreadyExistsError, InvalidUploadError
from utils import get_path_name_and_extension

if TYPE_CHECKING:
    from litestar.datastructures import UploadFile

    from db.repositories.posts import PostRepo
    from db.repositories.tags import TagGroupRepo
    from db.repositories.vectors import VectorRepo

# Plain browser UA so hotlink-protected hosts (e.g. pixiv's i.pximg.net) serve us.
_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"


class UploadIntake:
    """Persist an uploaded/fetched image as a post and trigger its backfill."""

    def __init__(self, posts: PostRepo, vectors: VectorRepo, tag_group_repo: TagGroupRepo) -> None:
        self._posts = posts
        self._vectors = vectors
        self._tag_group_repo = tag_group_repo

    async def store(
        self,
        *,
        file: UploadFile | None,
        url: str | None,
        path: str | None,
        source: str | None,
    ) -> None:
        source = source or "unknown"
        if file is None and url is None:
            raise InvalidUploadError

        file_io = await self._read_bytes(file, url)
        path = self._resolve_path(file, url, path)

        abs_path = shared.target_dir / path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        file_path, file_name, file_ext = get_path_name_and_extension(abs_path)
        if abs_path.exists():
            raise FileAlreadyExistsError

        await self._posts.create(
            file_path=file_path,
            file_name=file_name,
            extension=file_ext,
            source=source,
        )
        with abs_path.open("wb") as f:
            await asyncio.to_thread(shutil.copyfileobj, file_io, f)

        from processors import process_post  # noqa: PLC0415  # lazy: defer ML stack load until first use

        await process_post(self._posts, self._vectors, self._tag_group_repo, abs_path)

    @staticmethod
    async def _read_bytes(file: UploadFile | None, url: str | None) -> io.BytesIO | object:
        if file is not None:
            return file.file
        headers = {"user-agent": _BROWSER_UA}
        if url and "pximg.net" in url:
            headers["referer"] = "https://www.pixiv.net/"
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, headers=headers)
        return io.BytesIO(resp.content)

    @staticmethod
    def _resolve_path(file: UploadFile | None, url: str | None, path: str | None) -> str:
        if not path and file is not None and file.filename:
            return file.filename
        if path and file is not None and file.filename:
            return f"{path}/{file.filename}"
        return path or (url.split("/")[-1] if url else "")
