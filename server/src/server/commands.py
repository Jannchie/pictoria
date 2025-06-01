import asyncio
import contextlib
import os
from datetime import UTC, datetime
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from ai.make_captions import OpenAIImageAnnotator
from ai.waifu_scorer import get_waifu_scorer
from danbooru import DanbooruClient
from models import Post, PostHasTag, PostVector, PostWaifuScore, Tag, TagGroup
from processors import process_posts
from scheme import PostDetailPublic, Result
from server.utils import is_image
from server.utils.vec import get_img_vec
from utils import attach_tags_to_post, from_rating_to_int, get_tagger, logger


class CommandController(Controller):
    path = "/cmd"
    tags: ClassVar[list[str]] = ["Commands"]

    @litestar.put("/auto-caption/{post_id:int}")
    async def auto_caption(self, session: AsyncSession, post_id: int) -> PostDetailPublic:
        post: Post = await session.get(Post, post_id)
        if shared.openai_key is None:
            raise HTTPException(status_code=400, detail="OpenAI API key is not set")

        if shared.caption_annotator is None:
            shared.caption_annotator = OpenAIImageAnnotator(shared.openai_key)

        post.caption = shared.caption_annotator.annotate_image(post.absolute_path)
        session.add(post)
        await session.commit()
        await session.refresh(post)
        return PostDetailPublic.model_validate(post)

    @litestar.put("/auto-tags/{post_id:int}", description="Auto tag a post")
    async def auto_tags(self, post_id: int, session: AsyncSession) -> PostDetailPublic:
        post = await session.get(Post, post_id)
        if post is None:
            msg = f"Post with ID {post_id} not found."
            raise NotFoundException(msg)
        abs_path = post.absolute_path
        tagger = get_tagger()
        resp = tagger.tag(abs_path)
        post.rating = from_rating_to_int(resp.rating)
        await attach_tags_to_post(session, post, resp, is_auto=True)
        session.add(post)
        await session.flush()
        await session.refresh(post)
        return PostDetailPublic.model_validate(post)

    @litestar.put("/auto-tags")
    async def auto_tags_all(self, session: AsyncSession) -> None:
        batch_size = 32
        tagger = get_tagger()
        last_id = 0

        while True:
            query = select(Post).where(Post.rating == 0, Post.id > last_id).order_by(Post.id).limit(batch_size)
            posts = (await session.scalars(query)).all()

            # Exit loop when no more posts are found
            if not posts:
                break

            if valid_posts := [post for post in posts if is_image(post.absolute_path) and post.rating == 0]:
                try:
                    await self.process_tag_batch(session, tagger, valid_posts)
                except Exception as e:
                    logger.error(f"Error processing batch starting with post {valid_posts[0].id}: {e}")
            last_id = posts[-1].id
            logger.info(f"Processed batch up to ID: {last_id}")

    @litestar.put("/waifu-scorer")
    async def auto_waifu_scorer(self, session: AsyncSession) -> None:
        """
        Use Waifu Scorer to tag posts with a rating of 0.
        """
        batch_size = 32
        waifu_scorer = get_waifu_scorer()
        last_id = 0
        from rich.progress import Progress

        with Progress() as progress:
            task = progress.add_task("Waifu Scorer")
            while True:
                with contextlib.suppress(Exception):
                    # sourcery skip: none-compare
                    stmt = select(Post).where(Post.waifu_score == None, Post.id > last_id).order_by(Post.id).limit(batch_size)  # noqa: E711
                    posts = (await session.scalars(stmt)).all()
                    if not posts:
                        break
                    last_id = posts[-1].id
                    posts = [post for post in posts if is_image(post.absolute_path)]
                    images = [post.absolute_path for post in posts]
                    results = await asyncio.to_thread(waifu_scorer, images)
                    for post, result in zip(posts, results, strict=True):
                        post.waifu_score = PostWaifuScore(post_id=post.id, score=result)
                        session.add(post)
                    await session.commit()
                    progress.update(task, advance=len(posts))

    @litestar.get("/waifu-scorer/{post_id:int}")
    async def get_waifu_scorer(self, post_id: int, session: AsyncSession) -> float:
        """
        Get Waifu Scorer result for a post.
        """
        post = await session.get(Post, post_id)
        waifu_scorer = get_waifu_scorer()
        if post is None:
            msg = f"Post with ID {post_id} not found."
            raise NotFoundException(msg)
        if not is_image(post.absolute_path):
            msg = f"Post {post_id} is not an image."
            raise HTTPException(status_code=400, detail=msg)
        if post.waifu_score is None:
            score = waifu_scorer(post.absolute_path)
            post.waifu_score = PostWaifuScore(post_id=post.id, score=score[0])
            session.add(post)
            await session.commit()
            return score[0]
        return 0.0

    @litestar.post("/posts/embedding", description="Calculate embedding for all posts")
    async def calculate_embedding(self, session: AsyncSession) -> Result:
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

    @litestar.post("/download-from-danbooru", description="Download posts from Danbooru")
    async def download_from_danbooru(self, session: AsyncSession, tags: str) -> None:
        """
        Download posts from https://danbooru.donmai.us/ and save them to the database.
        """
        client = DanbooruClient(os.getenv("DANBOORU_API_KEY"), os.getenv("DANBOORU_USER_NAME"))
        danbooru_dir = shared.target_dir / "danbooru"
        save_dir = danbooru_dir / tags
        posts_orig = client.get_posts(tags=tags, limit=99999)
        posts = [post for post in posts_orig if post.file_url]
        logger.info(f"Fetched {len(posts)} avaliable posts ({len(posts_orig)} total)")
        type_to_group_id = await self.fetch_tag_group_ids(session)
        types = type_to_group_id.keys()
        for post in posts:
            if not post.file_url:
                continue
            ext = post.file_ext
            if ext not in {
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".webp",
                ".avif",
                ".bmp",
                ".tiff",
                ".tif",
                ".svg",
                "jpg",
                "jpeg",
                "png",
                "gif",
                "webp",
                "avif",
                "bmp",
                "tiff",
                "tif",
                "svg",
            }:
                continue
            now = datetime.now(UTC)
            file_path = save_dir.relative_to(shared.target_dir).as_posix()
            if not save_dir.exists():
                save_dir.mkdir(parents=True, exist_ok=True)
            resp = await session.execute(
                insert(Post)
                .values(
                    {
                        "file_path": file_path,
                        "file_name": str(post.id),
                        "extension": post.file_ext,
                        "source": f"https://danbooru.donmai.us/posts/{post.id}",
                        "rating": from_rating_to_int(post.rating),
                        "updated_at": now,
                        "created_at": now,
                        "published_at": post.created_at,
                    },
                )
                .on_conflict_do_update(
                    index_elements=["file_path", "file_name", "extension"],
                    set_={
                        "published_at": post.created_at,
                        "source": f"https://danbooru.donmai.us/posts/{post.id}",
                    },
                )
                .returning(Post.id),
            )
            post_id = resp.scalar()
            if post_id is None:
                continue
            for t in types:
                for tag_str in getattr(post, f"tag_string_{t}").split(" "):
                    tag_name = tag_str.replace("_", " ")
                    await session.execute(
                        insert(Tag)
                        .values(
                            {
                                "name": tag_name,
                                "group_id": type_to_group_id[t],
                            },
                        )
                        .on_conflict_do_nothing(),
                    )
                    await session.execute(
                        insert(PostHasTag)
                        .values(
                            {
                                "post_id": post_id,
                                "tag_name": tag_name,
                                "is_auto": False,
                            },
                        )
                        .on_conflict_do_nothing(),
                    )
        await asyncio.to_thread(client.download_posts, posts, save_dir)
        await process_posts(session=session)

    async def fetch_tag_group_ids(self, session: AsyncSession) -> dict[str, int]:
        general_group_id = (await session.scalar(select(TagGroup).filter(TagGroup.name == "general"))).id
        character_group_id = (await session.scalar(select(TagGroup).filter(TagGroup.name == "character"))).id
        artist_group_id = (await session.scalar(select(TagGroup).filter(TagGroup.name == "artist"))).id
        meta_group_id = (await session.scalar(select(TagGroup).filter(TagGroup.name == "meta"))).id
        return {
            "general": general_group_id,
            "character": character_group_id,
            "artist": artist_group_id,
            "meta": meta_group_id,
        }
