import asyncio
import os
from datetime import UTC, datetime
from typing import ClassVar

import litestar
from litestar import Controller
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

import shared
from danbooru import DanbooruClient
from models import Post, PostHasTag, PostVector, Tag, TagGroup
from processors import process_posts
from scheme import Result
from server.utils.vec import get_img_vec
from utils import from_rating_to_int, logger


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

    @litestar.post("/download-from-danbooru", description="Download posts from Danbooru")
    async def cmd_download_from_danbooru(self, session: AsyncSession, tags: str) -> dict:
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
