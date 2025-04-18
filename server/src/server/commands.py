from typing import ClassVar

import litestar
from litestar import Controller
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import Post, PostVector
from scheme import Result
from server.utils.vec import get_img_vec
from utils import logger


class CommandController(Controller):
    path = "/cmd"
    tags: ClassVar[list[str]] = ["Commands"]

    @litestar.post("/posts/embedding", description="Calculate embedding for all posts")
    async def cmd_calculate_embedding(self, session: AsyncSession) -> dict:
        stmt = select(Post).join(PostVector).where(PostVector.embedding.is_(None))
        posts = (await session.scalars(stmt)).all()
        if not posts:
            return Result(msg="Embedding already calculated.")
        for post in posts:
            logger.info("Calculating embedding for post ID: %s", post.id)
            vector = await get_img_vec(session, post)
            post_vector = PostVector(post_id=post.id, vector=vector)
            session.add(post_vector)
            await session.commit()
        return Result(msg=f"Calculated embedding for {len(posts)} posts.")
