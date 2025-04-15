from dataclasses import dataclass, field
from typing import Annotated, ClassVar, Literal

import litestar
from litestar import Controller
from msgspec import Meta, Struct
from sqlalchemy import Select, delete, func, nulls_last, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from models import Post, PostHasTag
from scheme import PostDTO


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
    tags: ClassVar[list[str]] = ["posts"]

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

    @litestar.post("/count", status_code=200, description="Count posts by filters.")
    async def count_posts(self, session: AsyncSession, data: ListPostBody) -> CountPostsResponse:
        stmt = apply_body_query(data, select(func.count(Post.id)))
        count = (await session.scalar(stmt)) or 0
        return CountPostsResponse(count=count)

    @litestar.post("/count/rating")
    async def count_rating(self, session: AsyncSession, data: ListPostBody) -> list[RatingCountItem]:
        return await self._count_by_column(session, data, Post.rating, RatingCountItem)

    @litestar.post("/count/score")
    async def count_score(self, session: AsyncSession, data: ListPostBody) -> list[ScoreCountItem]:
        return await self._count_by_column(session, data, Post.score, ScoreCountItem)

    @litestar.post("/count/extension")
    async def count_extension(self, session: AsyncSession, data: ListPostBody) -> list[ExtensionCountItem]:
        return await self._count_by_column(session, data, Post.extension, ExtensionCountItem)

    @litestar.put("/{post_id:int}", description="Update post by id.")
    async def update_post(self, session: AsyncSession, post_id: int, data: ScoreUpdate) -> Post:
        p = (await session.execute(select(Post).filter(Post.id == post_id))).scalars().first()
        if not p:
            msg = f"Post with id {post_id} not found."
            raise ValueError(msg)
        p.score = data.score
        await session.flush()
        return p

    @litestar.delete("/delete", description="Delete posts by ids.")
    async def delete_posts(self, session: AsyncSession, ids: list[int]) -> None:
        await session.execute(delete(Post).where(Post.id.in_(ids)))

    async def _count_by_column(self, session: AsyncSession, data: ListPostBody, column: Post, result_class: type) -> list:
        stmt = select(column, func.count()).group_by(column)
        stmt = apply_body_query(data, stmt)
        resp = await session.execute(stmt)
        return [result_class(**{column.name: item[0], "count": item[1]}) for item in resp]
