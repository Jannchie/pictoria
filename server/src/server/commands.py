import asyncio
import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from ai.make_captions import OpenAIImageAnnotator
from danbooru import DanbooruClient
from models import Post, PostHasTag, PostVector, Tag, TagGroup
from processors import process_posts
from scheme import PostDetailPublic, Result
from server.utils import is_image
from server.utils.vec import get_img_vec
from utils import attach_tags_to_post, from_rating_to_int, get_tagger, logger

if TYPE_CHECKING:
    from wdtagger import Tagger


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
        posts = await session.stream_scalars(select(Post).where(Post.rating.is_(None)))
        tagger = get_tagger()
        batch_size = 8
        batch = []
        async for post in posts:
            if not is_image(post.absolute_path):
                continue
            batch.append(post)
            if len(batch) < batch_size:
                continue
            await self.process_tag_batch(session, tagger, batch)
            batch.clear()
        if batch:
            await self.process_tag_batch(session, tagger, batch)
            batch.clear()

    async def process_tag_batch(self, session: AsyncSession, tagger: "Tagger", batch: list[Post]) -> None:
        abs_paths = [post.absolute_path for post in batch]
        try:
            responses = tagger.tag(abs_paths)
            for post, resp in zip(batch, responses, strict=True):
                post.rating = from_rating_to_int(resp.rating)
                await attach_tags_to_post(session, post, resp, is_auto=True)
        except Exception as e:
            shared.logger.error(f"Error processing batch starting with post {batch[0].id}: {e}")
            for post in batch:
                try:
                    response = tagger.tag([post.absolute_path])[0]
                    post.rating = from_rating_to_int(response.rating)
                    await attach_tags_to_post(session, post, response, is_auto=True)
                except Exception as single_e:
                    shared.logger.error(f"Error processing post {post.id}: {single_e}")
        logger.info("Batch processing complete.")
        await session.commit()

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
                        "rating": from_rating_to_int(post.rating),
                        "updated_at": now,
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
