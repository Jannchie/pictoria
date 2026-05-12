import asyncio
import os
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import HTTPException, NotFoundException

import shared
from ai.make_captions import OpenAIImageAnnotator
from ai.waifu_scorer import get_waifu_scorer
from danbooru import DanbooruClient
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from scheme import PostDetailPublic, Result
from server.utils import is_image
from server.utils.vec import get_image_vec
from services.waifu import waifu_score_all_posts
from utils import (
    TAG_GROUP_COLORS,
    attach_wdtagger_results,
    from_rating_to_int,
    get_tagger,
    logger,
)


class CommandController(Controller):
    path = "/cmd"
    tags: ClassVar[list[str]] = ["Commands"]

    @litestar.put("/auto-caption/{post_id:int}")
    async def auto_caption(self, posts: PostRepo, post_id: int) -> PostDetailPublic:
        post = await posts.get(post_id)
        if post is None:
            msg = f"Post with ID {post_id} not found."
            raise NotFoundException(msg)
        if shared.openai_key is None:
            raise HTTPException(status_code=400, detail="OpenAI API key is not set")
        if shared.caption_annotator is None:
            shared.caption_annotator = OpenAIImageAnnotator(shared.openai_key)

        caption = await asyncio.to_thread(shared.caption_annotator.annotate_image, post.absolute_path)
        await posts.update_field(post_id, "caption", caption)
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/auto-tags/{post_id:int}", description="Auto tag a post")
    async def auto_tags(
        self,
        posts: PostRepo,
        tag_group_repo: TagGroupRepo,
        post_id: int,
    ) -> PostDetailPublic:
        post = await posts.get(post_id)
        if post is None:
            msg = f"Post with ID {post_id} not found."
            raise NotFoundException(msg)

        tagger = get_tagger()
        resp = await asyncio.to_thread(tagger.tag, post.absolute_path)
        await posts.update_field(post_id, "rating", from_rating_to_int(resp.rating))
        await attach_wdtagger_results(posts, tag_group_repo, post_id, resp, is_auto=True)
        return PostDetailPublic.model_validate(await posts.get_detail(post_id))

    @litestar.put("/auto-tags")
    async def auto_tags_all(self, posts: PostRepo, tag_group_repo: TagGroupRepo) -> None:
        """Batch auto-tag every post that hasn't been rated yet."""
        batch_size = 32
        tagger = get_tagger()
        last_id = 0

        while True:
            def _next_batch(_last_id: int = last_id) -> list[dict]:
                posts.cur.execute(
                    "SELECT id, file_path, file_name, extension FROM posts "
                    "WHERE rating = 0 AND id > ? ORDER BY id LIMIT ?",
                    [_last_id, batch_size],
                )
                cols = ["id", "file_path", "file_name", "extension"]
                return [dict(zip(cols, r, strict=True)) for r in posts.cur.fetchall()]

            batch = await asyncio.to_thread(_next_batch)
            if not batch:
                break
            for row in batch:
                abs_path = shared.target_dir / row["file_path"] / f"{row['file_name']}.{row['extension']}"
                if not is_image(abs_path):
                    continue
                try:
                    resp = await asyncio.to_thread(tagger.tag, abs_path)
                    await posts.update_field(row["id"], "rating", from_rating_to_int(resp.rating))
                    await attach_wdtagger_results(posts, tag_group_repo, row["id"], resp, is_auto=True)
                except Exception:
                    logger.exception(f"Failed to tag post {row['id']}")
            last_id = batch[-1]["id"]
            logger.info(f"Processed batch up to ID: {last_id}")

    @litestar.put("/waifu-scorer")
    async def auto_waifu_scorer(self, posts: PostRepo) -> None:
        """Batch-score all posts that don't have a waifu score."""
        await waifu_score_all_posts(posts)

    @litestar.get("/waifu-scorer/{post_id:int}")
    async def get_waifu_scorer_one(self, posts: PostRepo, post_id: int) -> float:
        """Compute (and persist) the waifu score for a single post."""
        post = await posts.get(post_id)
        if post is None:
            msg = f"Post with ID {post_id} not found."
            raise NotFoundException(msg)
        if not is_image(post.absolute_path):
            raise HTTPException(status_code=400, detail=f"Post {post_id} is not an image.")
        existing = await posts.get_waifu_score(post_id)
        if existing is not None:
            return existing
        scorer = get_waifu_scorer()
        result = await asyncio.to_thread(scorer, post.absolute_path)
        score = float(result[0]) if isinstance(result, (list, tuple)) else float(result)
        await posts.upsert_waifu_score(post_id, score)
        return score

    @litestar.post("/posts/embedding", description="Calculate embedding for posts that don't have one yet")
    async def calculate_embedding(
        self,
        posts: PostRepo,
        vectors: VectorRepo,
    ) -> Result:
        ids = await vectors.list_missing_post_ids()
        if not ids:
            return Result(msg="Embedding already calculated.")
        done = 0
        for pid in ids:
            post = await posts.get(pid)
            if not post or not is_image(post.absolute_path):
                continue
            try:
                emb = await get_image_vec(post.absolute_path)
                await vectors.upsert(pid, emb)
                done += 1
            except Exception:
                logger.exception(f"Failed to calculate embedding for post {pid}")
        return Result(msg=f"Calculated embedding for {done} posts.")

    @litestar.post("/download-from-danbooru", description="Download posts from Danbooru")
    async def download_from_danbooru(
        self,
        posts: PostRepo,
        tag_group_repo: TagGroupRepo,
        tags: str,
    ) -> None:
        """Download posts from Danbooru and persist them."""
        client = DanbooruClient(os.getenv("DANBOORU_API_KEY", ""), os.getenv("DANBOORU_USER_NAME", ""))
        danbooru_dir = shared.target_dir / "danbooru"
        save_dir = danbooru_dir / tags
        posts_orig = client.get_posts(tags=tags, limit=99999)
        posts_with_url = [p for p in posts_orig if p.file_url]
        logger.info(f"Fetched {len(posts_with_url)} available posts ({len(posts_orig)} total)")

        # ensure canonical tag groups exist
        type_to_group_id = await _fetch_or_create_canonical_groups(tag_group_repo)
        types = list(type_to_group_id.keys())

        filtered = [
            p for p in posts_with_url
            if p.file_ext and p.file_ext.lower()
            in {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"}
        ]
        for d_post in filtered:
            if not d_post.file_url:
                continue
            file_path = save_dir.relative_to(shared.target_dir).as_posix()
            if not save_dir.exists():
                save_dir.mkdir(parents=True, exist_ok=True)
            post_id = await posts.upsert_from_danbooru(
                file_path=file_path,
                file_name=str(d_post.id),
                extension=d_post.file_ext,
                source=f"https://danbooru.donmai.us/posts/{d_post.id}",
                rating=from_rating_to_int(d_post.rating),
                published_at=d_post.created_at,
            )
            if post_id is None:
                continue
            for t in types:
                for tag_str in getattr(d_post, f"tag_string_{t}").split(" "):
                    if not tag_str:
                        continue

                    def _insert_tag_and_link(_t: str = tag_str, _gid: int = type_to_group_id[t], _pid: int = post_id) -> None:
                        cur = posts.cur
                        cur.execute(
                            "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                            [_t, _gid],
                        )
                        cur.execute(
                            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, FALSE) "
                            "ON CONFLICT DO NOTHING",
                            [_pid, _t],
                        )

                    await asyncio.to_thread(_insert_tag_and_link)

        await asyncio.to_thread(client.download_posts, filtered, save_dir)
        # Defer heavy processing to background; can be called explicitly via /cmd/posts/embedding etc.


async def _fetch_or_create_canonical_groups(tag_group_repo: TagGroupRepo) -> dict[str, int]:
    """Ensure the four canonical groups exist and return name → id mapping."""
    result: dict[str, int] = {}
    for name in ("general", "character", "artist", "meta"):
        color = TAG_GROUP_COLORS.get(name, "#000000")
        group = await tag_group_repo.ensure(name, color=color)
        result[name] = group.id
    return result
