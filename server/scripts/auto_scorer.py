from sqlalchemy import update

from db import ASession
from models import Post, PostWaifuScore


async def auto_scorer():
    async with ASession() as session:
        stmt = update(Post).values(score=1).where(Post.score == 0, Post.id == PostWaifuScore.post_id, PostWaifuScore.score != 0, PostWaifuScore.score < 2)  # noqa: PLR2004
        await session.execute(stmt)
        stmt = update(Post).values(score=2).where(Post.score == 0, Post.id == PostWaifuScore.post_id, PostWaifuScore.score >= 2, PostWaifuScore.score < 4)  # noqa: PLR2004
        await session.execute(stmt)
        stmt = update(Post).values(score=3).where(Post.score == 0, Post.id == PostWaifuScore.post_id, PostWaifuScore.score >= 4, PostWaifuScore.score < 7.5)  # noqa: PLR2004
        await session.execute(stmt)
        stmt = update(Post).values(score=4).where(Post.score == 0, Post.id == PostWaifuScore.post_id, PostWaifuScore.score >= 7.5, PostWaifuScore.score < 8)  # noqa: PLR2004
        await session.execute(stmt)
        stmt = update(Post).values(score=5).where(Post.score == 0, Post.id == PostWaifuScore.post_id, PostWaifuScore.score >= 8)  # noqa: PLR2004
        await session.execute(stmt)
        await session.commit()


if __name__ == "__main__":
    import asyncio

    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # For Windows compatibility
    asyncio.run(auto_scorer())
