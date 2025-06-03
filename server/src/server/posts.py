import asyncio
import io
import shutil
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, ClassVar, Literal

import httpx
import litestar
from litestar import Controller
from litestar.datastructures import UploadFile
from litestar.enums import RequestEncodingType
from litestar.exceptions import HTTPException, NotFoundException
from litestar.params import Body
from litestar.status_codes import HTTP_409_CONFLICT
from msgspec import Meta, Struct
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, delete, func, nulls_last, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

import shared
from models import Post, PostHasTag
from processors import process_post
from scheme import DTOBaseModel, PostDetailPublic, PostHasColorPublic
from server.utils.vec import find_similar_posts, get_img_vec_by_id
from utils import get_path_name_and_extension

if TYPE_CHECKING:
    from sqlalchemy.orm import MappedColumn


class PostFilter(Struct):
    """Filter for searching posts."""

    rating: Annotated[
        tuple[int, ...] | None,
        Meta(
            description="Rating to filter by.",
            examples=[(1, 2, 3)],  # 注意: examples 需要是一个包含示例值的列表
        ),
    ] = ()

    score: Annotated[tuple[int, ...] | None, Meta(description="Score to filter by.", examples=[(1, 2, 3)])] = ()
    tags: Annotated[tuple[str, ...] | None, Meta(description="Tags to filter by.", examples=[("tag1", "tag2")])] = ()
    extension: Annotated[tuple[str, ...] | None, Meta(description="File extensions to filter by.", examples=[("jpg", "png")])] = ()

    folder: str | None = None

    lab: Annotated[
        tuple[float, float, float] | None,
        Meta(
            description="Lab color space values for filtering.",
            examples=[(0.5, 0.5, 0.5)],
            extra_json_schema={
                "min_length": 3,
                "max_length": 3,
            },
        ),
    ] = None


class PostFilterWithOrder(PostFilter):
    """Filter for searching posts with ordering."""

    order_by: Annotated[
        Literal["id", "score", "rating", "created_at", "published_at", "file_name"] | None,
        Meta(
            description="Field to order by.",
            examples=["id"],
            extra_json_schema={
                "enum": ["id", "score", "rating", "created_at", "published_at", "file_name"],
            },
        ),
    ] = None

    order: Annotated[
        Literal["asc", "desc", "random"],
        Meta(
            description="Order direction.",
            examples=["desc", "asc", "random"],
            extra_json_schema={
                "enum": ["asc", "desc", "random"],
            },
        ),
    ] = "desc"


def apply_body_filter(filter: PostFilter, stmt: Select) -> Select:  # noqa: A002
    if filter.rating:
        stmt = stmt.filter(Post.rating.in_(filter.rating))
    if filter.score:
        stmt = stmt.filter(Post.score.in_(filter.score))
    if filter.tags:
        stmt = stmt.join(Post.tags).filter(PostHasTag.tag_name.in_(filter.tags))
    if filter.extension:
        stmt = stmt.filter(Post.extension.in_(filter.extension))
    if filter.folder and filter.folder != ".":
        stmt = stmt.filter(Post.file_path.like(f"{filter.folder}%"))
    return stmt


@dataclass
class CountPostsResponse:
    count: int


@dataclass
class RatingCountItem:
    rating: int
    count: int


@dataclass
class ScoreCountItem:
    score: int
    count: int


@dataclass
class ExtensionCountItem:
    extension: str
    count: int


class ScoreUpdate(Struct):
    score: Annotated[int, Meta(ge=0, le=5, description="Score from 0 to 5.")]


class PostSimplePublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    rating: int
    width: int
    height: int
    aspect_ratio: float | None = None
    dominant_color: list[float] | None = None
    colors: list[PostHasColorPublic]
    md5: str


class PostController(Controller):
    path = "/posts"
    tags: ClassVar[list[str]] = ["Posts"]

    simple_select_stmt = select(Post).options(
        load_only(
            Post.id,
            Post.file_path,
            Post.file_name,
            Post.extension,
            Post.rating,
            Post.width,
            Post.height,
            Post.aspect_ratio,
            Post.dominant_color,
            Post.md5,
        ),
    )

    @litestar.post("/search", status_code=200, description="Search for posts by filters.")
    async def search_posts(self, session: AsyncSession, data: PostFilterWithOrder, limit: int = 100, offset: int = 0) -> list[PostSimplePublic]:
        await session.execute(text("SELECT setseed(0.47)"))

        if data.lab:
            l, a, b = data.lab  # noqa: E741
            lab_vec = [l, a, b]
            distance = Post.dominant_color.l2_distance(lab_vec)
            stmt = apply_body_filter(data, self.simple_select_stmt).order_by(nulls_last(distance)).limit(limit).offset(offset)
            results = (await session.scalars(stmt)).all()
            return [PostSimplePublic.model_validate(post) for post in results]
        stmt = apply_body_filter(data, self.simple_select_stmt).limit(limit).offset(offset)
        if data.order_by:
            order_column: MappedColumn = getattr(Post, data.order_by)
            if data.order == "random":
                stmt = stmt.order_by(func.random())
            elif data.order == "asc":
                stmt = stmt.order_by(order_column.asc().nullslast())
            elif data.order == "desc":
                stmt = stmt.order_by(order_column.desc().nullslast())
            else:
                msg = f"Invalid order value: {data.order}"
                raise HTTPException(detail=msg, status_code=HTTP_409_CONFLICT)
        return [PostSimplePublic.model_validate(post) for post in (await session.scalars(stmt)).all()]

    @litestar.get("/{post_id:int}", status_code=200)
    async def get_post(self, session: AsyncSession, post_id: int) -> PostDetailPublic:
        """Get post by id."""
        post = await session.get(Post, post_id)

        group_name_order = ["artist", "copyright", "character", "general", "meta"]

        if post and post.tags:
            post.tags.sort(key=lambda x: group_name_order.index(x.tag_info.group.name) if x.tag_info.group.name in group_name_order else len(group_name_order))

        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        return PostDetailPublic.model_validate(post)

    @litestar.get("/{post_id:int}/similar", status_code=200)
    async def get_similar_posts(self, session: AsyncSession, post_id: int, limit: int = 100) -> list[PostSimplePublic]:
        """Get similar posts by id."""
        vec = await get_img_vec_by_id(session, post_id)
        resp = await find_similar_posts(session, vec, limit=limit)
        id_list = [row.post_id for row in resp]
        stmt = self.simple_select_stmt.where(Post.id.in_(id_list)).order_by(func.array_position(id_list, Post.id))
        return [PostSimplePublic.model_validate(post) for post in (await session.scalars(stmt)).all()]

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def get_posts_count(self, session: AsyncSession, data: PostFilter) -> CountPostsResponse:
        """Count posts by filters."""
        stmt = apply_body_filter(data, select(func.count(Post.id)))
        count = (await session.scalar(stmt)) or 0
        return CountPostsResponse(count=count)

    @litestar.post("/count/rating", status_code=200, description="Count posts by rating.")
    async def get_rating_count(self, session: AsyncSession, data: PostFilter) -> list[RatingCountItem]:
        """Count posts by rating."""
        return await self._count_by_column(session, data, Post.rating, RatingCountItem)

    @litestar.post("/count/score", status_code=200, description="Count posts by score.")
    async def get_score_count(self, session: AsyncSession, data: PostFilter) -> list[ScoreCountItem]:
        """Count posts by score."""
        return await self._count_by_column(session, data, Post.score, ScoreCountItem)

    @litestar.post("/count/extension", status_code=200, description="Count posts by extension.")
    async def get_extension_count(self, session: AsyncSession, data: PostFilter) -> list[ExtensionCountItem]:
        """Count posts by extension."""
        return await self._count_by_column(session, data, Post.extension, ExtensionCountItem)

    @litestar.put("/{post_id:int}/score")
    async def update_post_score(self, session: AsyncSession, post_id: int, data: ScoreUpdate) -> PostDetailPublic:
        """Update post score by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.score = data.score
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return PostDetailPublic.model_validate(p)

    @litestar.put("/{post_id:int}/rating")
    async def update_post_rating(self, session: AsyncSession, post_id: int, rating: int) -> PostDetailPublic:
        """Update post rating by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.rating = rating
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return PostDetailPublic.model_validate(p)

    @litestar.put("/{post_id:int}/caption")
    async def update_post_caption(self, session: AsyncSession, post_id: int, caption: str) -> PostDetailPublic:
        """Update post caption by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.caption = caption
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return PostDetailPublic.model_validate(p)

    @litestar.put("/{post_id:int}/source")
    async def update_post_source(self, session: AsyncSession, post_id: int, source: str) -> PostDetailPublic:
        """Update post source by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.source = source
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return PostDetailPublic.model_validate(p)

    @litestar.delete("/delete")
    async def delete_posts(self, session: AsyncSession, ids: list[int]) -> None:
        """Delete posts by ids."""
        await session.execute(delete(Post).where(Post.id.in_(ids)))

    @litestar.put("/{post_id:int}/rotate")
    async def rotate_post_image(self, session: AsyncSession, post_id: int, *, clockwise: bool = True) -> PostDetailPublic:
        """
        Rotate post image by id.
        It will rotate the image and update md5, width and height.
        """
        post = await session.get(Post, post_id)
        if post is None:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        await asyncio.to_thread(post.rotate, clockwise=clockwise)
        await session.commit()
        await session.refresh(post)
        return PostDetailPublic.model_validate(post)

    @litestar.put("/{post_id:int}/tags/{tag_name:str}")
    async def add_tag_to_post(self, session: AsyncSession, post_id: int, tag_name: str) -> PostDetailPublic:
        """Add tag to post by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        tag = await session.get(PostHasTag, (post_id, tag_name))
        if not tag:
            tag = PostHasTag(post_id=post_id, tag_name=tag_name)
            session.add(tag)
        else:
            msg = f"Tag {tag_name} already exists in post {post_id}."
            raise HTTPException(detail=msg, status_code=HTTP_409_CONFLICT)
        return PostDetailPublic.model_validate(post)

    @litestar.delete("/{post_id:int}/tags/{tag_name:str}", status_code=200)
    async def remove_tag_from_post(self, session: AsyncSession, post_id: int, tag_name: str) -> PostDetailPublic:
        """Remove tag from post by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        tag = await session.get(PostHasTag, (post_id, tag_name))
        if tag:
            await session.delete(tag)
        else:
            msg = f"Tag {tag_name} does not exist in post {post_id}."
            raise HTTPException(detail=msg, status_code=HTTP_409_CONFLICT)
        return PostDetailPublic.model_validate(post)

    @litestar.put("/bulk/score")
    async def bulk_update_post_score(self, session: AsyncSession, ids: list[int], score: int) -> None:
        """Update score for multiple posts by ids."""
        max_score = 5
        if not 0 <= score <= max_score:
            msg = f"Score must be between 0 and 5, got {score}."
            raise HTTPException(detail=msg, status_code=HTTP_409_CONFLICT)

        for post_id in ids:
            p = await session.get(Post, post_id)
            if p:
                p.score = score
                session.add(p)

        await session.commit()

    @litestar.put("/bulk/rating")
    async def bulk_update_post_rating(self, session: AsyncSession, ids: list[int], rating: int) -> None:
        """Update rating for multiple posts by ids."""
        max_rating = 4
        if not 0 <= rating <= max_rating:
            msg = f"Rating must be between 0 and 4, got {rating}."
            raise HTTPException(detail=msg, status_code=HTTP_409_CONFLICT)

        for post_id in ids:
            p = await session.get(Post, post_id)
            if p:
                p.rating = rating
                session.add(p)

        await session.commit()

    async def _count_by_column(self, session: AsyncSession, data: PostFilter, column: Post, result_class: type) -> list:
        stmt = select(column, func.count()).group_by(column)
        stmt = apply_body_filter(data, stmt)
        resp = await session.execute(stmt)
        return [result_class(**{column.name: item[0], "count": item[1]}) for item in resp]

    class UploadFormData(BaseModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)
        url: str | None = None
        path: str | None = None
        source: str | None = None
        file: UploadFile

    @litestar.post("/upload", tags=["Upload"])
    async def upload_file(
        self,
        data: Annotated[UploadFormData, Body(media_type=RequestEncodingType.MULTI_PART)],
        session: AsyncSession,
    ) -> None:
        path = data.path
        url = data.url
        file = data.file
        source = data.source or "unknown"
        if data.file is None and data.url is None:
            raise HTTPException(status_code=400, detail="Either file or url must be provided")
        if data.file is None:
            headers = {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            }
            if data.url and "pximg.net" in data.url:
                headers["referer"] = "https://www.pixiv.net/"
            with httpx.AsyncClient() as client:
                resp = await client.get(data.url, headers=headers)

            file_io = io.BytesIO(resp.content)
        else:
            file_io = file.file

        if not path and file is not None and file.filename:
            path = file.filename
        elif path and file is not None and file.filename:
            path = f"{path}/{file.filename}"
        else:
            path = path or (url.split("/")[-1] if url else "")
        abs_path = shared.target_dir / path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        file_path, file_name, file_ext = get_path_name_and_extension(abs_path)
        if abs_path.exists():
            raise HTTPException(status_code=400, detail="File already exists")
        post = Post(file_path=file_path, file_name=file_name, extension=file_ext, source=source)
        session.add(post)
        await session.commit()
        await session.refresh(post)
        with abs_path.open("wb") as f:
            await asyncio.to_thread(shutil.copyfileobj, file_io, f)
        await process_post(session, abs_path)
