import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, ClassVar, Literal

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from litestar.status_codes import HTTP_409_CONFLICT
from msgspec import Meta, Struct
from sqlalchemy import Select, delete, func, nulls_last, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from models import Post, PostHasTag
from scheme import PostDetailPublic, PostPublic
from server.utils.vec import find_similar_posts, get_img_vec

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


class PostController(Controller):
    path = "/posts"
    tags: ClassVar[list[str]] = ["Posts"]

    @litestar.post("/search", status_code=200, description="Search for posts by filters.")
    async def search_posts(self, session: AsyncSession, data: PostFilterWithOrder, limit: int = 100, offset: int = 0) -> list[PostPublic]:
        await session.execute(text("SELECT setseed(0.47)"))

        if data.lab:
            l, a, b = data.lab  # noqa: E741
            lab_vec = [l, a, b]
            distance = Post.dominant_color_np.l2_distance(lab_vec)
            stmt = apply_body_filter(data, select(Post)).order_by(nulls_last(distance)).limit(limit).offset(offset)
            return (await session.scalars(stmt)).all()

        stmt = apply_body_filter(data, select(Post)).limit(limit).offset(offset)
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
        # Check if order_by is provided and is "random"
        return [PostPublic.model_validate(post) for post in (await session.scalars(stmt)).all()]

    @litestar.get("/{post_id:int}", status_code=200)
    async def get_post(self, session: AsyncSession, post_id: int) -> PostDetailPublic:
        """Get post by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        return PostDetailPublic.model_validate(post)

    @litestar.get("/{post_id:int}/similar", status_code=200)
    async def get_similar_posts(self, session: AsyncSession, post_id: int, limit: int = 10) -> list[PostPublic]:
        """Get similar posts by id."""
        post = await session.get(Post, post_id)
        if not post:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        vec = await get_img_vec(session, post)
        resp = await find_similar_posts(session, vec, limit=limit)
        id_list = [row.post_id for row in resp]
        stmt = select(Post).filter(Post.id.in_(id_list)).order_by(func.array_position(id_list, Post.id))
        return [PostPublic.model_validate(post) for post in (await session.scalars(stmt)).all()]

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def get_posts_count(self, session: AsyncSession, data: PostFilter) -> CountPostsResponse:
        """Count posts by filters."""
        stmt = apply_body_filter(data, select(func.count(Post.id)))
        count = (await session.scalar(stmt)) or 0
        return CountPostsResponse(count=count)

    @litestar.post("/count/rating")
    async def get_tags_count(self, session: AsyncSession, data: PostFilter) -> list[RatingCountItem]:
        """Count posts by rating."""
        return await self._count_by_column(session, data, Post.rating, RatingCountItem)

    @litestar.post("/count/score")
    async def get_score_count(self, session: AsyncSession, data: PostFilter) -> list[ScoreCountItem]:
        """Count posts by score."""
        return await self._count_by_column(session, data, Post.score, ScoreCountItem)

    @litestar.post("/count/extension")
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
        await session.flush()
        return PostDetailPublic.model_validate(p)

    @litestar.put("/{post_id:int}/rating")
    async def update_post_rating(self, session: AsyncSession, post_id: int, rating: int) -> PostDetailPublic:
        """Update post rating by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.rating = rating
        await session.flush()
        return PostDetailPublic.model_validate(p)

    @litestar.put("/{post_id:int}/caption")
    async def update_post_caption(self, session: AsyncSession, post_id: int, caption: str) -> PostDetailPublic:
        """Update post caption by id."""
        p = await session.get(Post, post_id)
        if not p:
            msg = f"Post with id {post_id} not found."
            raise NotFoundException(detail=msg)
        p.caption = caption
        await session.flush()
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

    async def _count_by_column(self, session: AsyncSession, data: PostFilter, column: Post, result_class: type) -> list:
        stmt = select(column, func.count()).group_by(column)
        stmt = apply_body_filter(data, stmt)
        resp = await session.execute(stmt)
        return [result_class(**{column.name: item[0], "count": item[1]}) for item in resp]
