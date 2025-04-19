import asyncio
from dataclasses import dataclass, field
from typing import Annotated, ClassVar, Literal

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from litestar.status_codes import HTTP_409_CONFLICT
from msgspec import Meta, Struct
from sqlalchemy import Select, delete, func, nulls_last, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_img_vec
from models import Post, PostHasTag
from scheme import PostDTO
from server.utils.vec import find_similar_posts


@dataclass
class ListPostBody:
    rating: tuple[int] | None = field(default_factory=tuple)
    score: tuple[int] | None = field(default_factory=tuple)
    tags: tuple[str] | None = field(default_factory=tuple)
    extension: tuple[str] | None = field(default_factory=tuple)
    folder: str | None = None
    order_by: Literal["id", "score", "rating", "created_at", "published_at", "file_name"] | None = None
    order: Literal["asc", "desc", "random"] = "desc"
    lab: tuple[float, float, float] | None = None


def apply_body_query(filter: ListPostBody, stmt: Select) -> Select:  # noqa: A002
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
    if filter.order_by:
        order_column = getattr(Post, filter.order_by)
        if filter.order == "random":
            stmt = stmt.order_by(func.random())
        elif filter.order == "asc":
            stmt = stmt.order_by(order_column.asc().nullslast())
        elif filter.order == "desc":
            stmt = stmt.order_by(order_column.desc().nullslast())
        else:
            msg = f"Invalid order value: {filter.order}"
            raise ValueError(msg)
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


class PostController(Controller):
    path = "/posts"
    tags: ClassVar[list[str]] = ["Posts"]
    return_dto = PostDTO

    @litestar.post("/search", return_dto=PostDTO, status_code=200, description="Search for posts by filters.")
    async def search_posts(self, session: AsyncSession, data: ListPostBody, limit: int = 100, offset: int = 0) -> list[Post]:
        await session.execute(text("SELECT setseed(0.47)"))

        # Check if lab is provided and has 3 elements
        if data.lab and len(data.lab) == 3:  # noqa: PLR2004
            l, a, b = data.lab  # noqa: E741
            lab_vec = [l, a, b]
            distance = Post.dominant_color_np.l2_distance(lab_vec)
            stmt = apply_body_query(data, select(Post)).order_by(nulls_last(distance)).limit(limit).offset(offset)
            return (await session.scalars(stmt)).all()

        # Check if order_by is provided and is "random"
        stmt = apply_body_query(data, select(Post)).limit(limit).offset(offset)
        return (await session.scalars(stmt)).all()

    @litestar.get("/{post_id:int}", return_dto=PostDTO, status_code=200)
    async def get_post(self, session: AsyncSession, post_id: int) -> Post:
        """Get post by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        return post

    @litestar.get("/{post_id:int}/similar", return_dto=PostDTO, status_code=200)
    async def get_similar_posts(self, session: AsyncSession, post_id: int, limit: int = 10) -> list[Post]:
        """Get similar posts by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        vec = await get_img_vec(session, post)
        resp = await find_similar_posts(session, vec, limit=limit)
        id_list = [row.post_id for row in resp]
        stmt = select(Post).filter(Post.id.in_(id_list)).order_by(func.array_position(id_list, Post.id))
        return (await session.scalars(stmt)).all()

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def get_posts_count(self, session: AsyncSession, data: ListPostBody) -> CountPostsResponse:
        """Count posts by filters."""
        stmt = apply_body_query(data, select(func.count(Post.id)))
        count = (await session.scalar(stmt)) or 0
        return CountPostsResponse(count=count)

    @litestar.post("/count/rating")
    async def get_tags_count(self, session: AsyncSession, data: ListPostBody) -> list[RatingCountItem]:
        """Count posts by rating."""
        return await self._count_by_column(session, data, Post.rating, RatingCountItem)

    @litestar.post("/count/score")
    async def get_score_count(self, session: AsyncSession, data: ListPostBody) -> list[ScoreCountItem]:
        """Count posts by score."""
        return await self._count_by_column(session, data, Post.score, ScoreCountItem)

    @litestar.post("/count/extension")
    async def get_extension_count(self, session: AsyncSession, data: ListPostBody) -> list[ExtensionCountItem]:
        """Count posts by extension."""
        return await self._count_by_column(session, data, Post.extension, ExtensionCountItem)

    @litestar.put("/{post_id:int}/score")
    async def update_post_score(self, session: AsyncSession, post_id: int, data: ScoreUpdate) -> Post:
        """Update post score by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.score = data.score
        await session.flush()
        return p

    @litestar.put("/{post_id:int}/rating")
    async def update_post_rating(self, session: AsyncSession, post_id: int, rating: int) -> Post:
        """Update post rating by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.rating = rating
        await session.flush()
        return p

    @litestar.put("/{post_id:int}/caption")
    async def update_post_caption(self, session: AsyncSession, post_id: int, caption: str) -> Post:
        """Update post caption by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.caption = caption
        await session.flush()
        return p

    @litestar.delete("/delete")
    async def delete_posts(self, session: AsyncSession, ids: list[int]) -> None:
        """Delete posts by ids."""
        await session.execute(delete(Post).where(Post.id.in_(ids)))

    @litestar.put("/{post_id:int}/rotate")
    async def rotate_post_image(self, session: AsyncSession, post_id: int, *, clockwise: bool = True) -> Post:
        """
        Rotate post image by id.
        It will rotate the image and update md5, width and height.
        """
        post = await session.get(Post, post_id)
        if post is None:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        await asyncio.to_thread(post.rotate, clockwise=clockwise)
        return post

    @litestar.put("/{post_id:int}/tags/{tag_name:str}")
    async def add_tag_to_post(self, session: AsyncSession, post_id: int, tag_name: str) -> Post:
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
        return post

    @litestar.delete("/{post_id:int}/tags/{tag_name:str}", status_code=200)
    async def remove_tag_from_post(self, session: AsyncSession, post_id: int, tag_name: str) -> Post:
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
        return post

    async def _count_by_column(self, session: AsyncSession, data: ListPostBody, column: Post, result_class: type) -> list:
        stmt = select(column, func.count()).group_by(column)
        stmt = apply_body_query(data, stmt)
        resp = await session.execute(stmt)
        return [result_class(**{column.name: item[0], "count": item[1]}) for item in resp]
