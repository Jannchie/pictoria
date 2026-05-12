import asyncio
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.datastructures import State
from litestar.exceptions import HTTPException, NotFoundException

import shared
from danbooru import DanbooruClient
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from scheme import PostDetailPublic, Result
from server.utils import is_image
from utils import (
    TAG_GROUP_COLORS,
    attach_wdtagger_results,
    from_rating_to_int,
    get_tagger,
    logger,
)


@dataclass
class DanbooruDownloadStats:
    total: int
    with_url: int
    filtered: int
    downloaded: int
    skipped: int
    failed: int


@dataclass
class SnapshotResult:
    path: str
    dir: str


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
            from ai.make_captions import OpenAIImageAnnotator  # noqa: PLC0415  # lazy: defer ML stack load until first use

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
        from services.waifu import waifu_score_all_posts  # noqa: PLC0415  # lazy: defer ML stack load until first use

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
        from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer ML stack load until first use

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
        from server.utils.vec import get_image_vec  # noqa: PLC0415  # lazy: defer ML stack load until first use

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
    ) -> DanbooruDownloadStats:
        """Download posts from Danbooru and persist them."""
        client = DanbooruClient(os.getenv("DANBOORU_API_KEY", ""), os.getenv("DANBOORU_USER_NAME", ""))
        danbooru_dir = shared.target_dir / "danbooru"
        save_dir = danbooru_dir / tags
        posts_orig = await asyncio.to_thread(client.get_posts, tags=tags, limit=99999)
        posts_with_url = [p for p in posts_orig if p.file_url]
        logger.info(f"Fetched {len(posts_with_url)} available posts ({len(posts_orig)} total)")

        # ensure canonical tag groups exist
        type_to_group_id = await _fetch_or_create_canonical_groups(tag_group_repo)
        types = list(type_to_group_id.keys())

        filtered = [
            p for p in posts_with_url
            if p.file_url and p.file_ext and p.file_ext.lower()
            in {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"}
        ]
        save_dir.mkdir(parents=True, exist_ok=True)
        file_path_str = save_dir.relative_to(shared.target_dir).as_posix()

        def _existing_post_names() -> set[str]:
            posts.cur.execute(
                "SELECT file_name FROM posts WHERE file_path = ?",
                [file_path_str],
            )
            return {row[0] for row in posts.cur.fetchall()}

        existing_names = await asyncio.to_thread(_existing_post_names)
        to_persist = [p for p in filtered if str(p.id) not in existing_names]
        logger.info(f"Persisting {len(to_persist)} new posts ({len(filtered) - len(to_persist)} already in DB)")

        def _persist_all() -> None:
            if not to_persist:
                return
            cur = posts.cur
            cur.execute("BEGIN")
            try:
                for d_post in to_persist:
                    cur.execute(
                        """
                        INSERT INTO posts(file_path, file_name, extension, source, rating, published_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT (file_path, file_name, extension)
                        DO UPDATE SET source = excluded.source,
                                      published_at = excluded.published_at,
                                      updated_at = now()
                        RETURNING id
                        """,
                        [
                            file_path_str,
                            str(d_post.id),
                            d_post.file_ext,
                            f"https://danbooru.donmai.us/posts/{d_post.id}",
                            from_rating_to_int(d_post.rating),
                            d_post.created_at,
                        ],
                    )
                    row = cur.fetchone()
                    if not row:
                        continue
                    post_id = int(row[0])

                    # `types` is ordered by priority; setdefault keeps the
                    # first (highest-priority) group when a tag appears in
                    # multiple tag_string_* fields. Also dedupes within a
                    # single post — DuckDB's ON CONFLICT does not handle
                    # duplicates inside one executemany batch.
                    tag_to_group: dict[str, int] = {}
                    for t in types:
                        gid = type_to_group_id[t]
                        # str.split() with no args also drops empty entries
                        for tag_str in getattr(d_post, f"tag_string_{t}").split():
                            tag_to_group.setdefault(tag_str, gid)
                    if tag_to_group:
                        cur.executemany(
                            "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                            list(tag_to_group.items()),
                        )
                        cur.executemany(
                            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, FALSE) "
                            "ON CONFLICT DO NOTHING",
                            [(post_id, name) for name in tag_to_group],
                        )
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise

        await asyncio.to_thread(_persist_all)

        stats = await asyncio.to_thread(client.download_posts, filtered, save_dir)
        # Defer heavy processing to background; can be called explicitly via /cmd/posts/embedding etc.
        return DanbooruDownloadStats(
            total=len(posts_orig),
            with_url=len(posts_with_url),
            filtered=len(filtered),
            downloaded=stats.get("downloaded", 0),
            skipped=stats.get("skipped", 0),
            failed=stats.get("failed", 0),
        )

    @litestar.post("/db/snapshot", description="Create a point-in-time DuckDB snapshot for offline tooling")
    async def db_snapshot(self, state: State) -> SnapshotResult:
        """Snapshot the live DB to a tempfile so external readers can open it.

        DuckDB locks the live file exclusively (especially on Windows), so
        external processes can't even open it read-only while the server is
        running. Here we use ATTACH + COPY FROM DATABASE inside the server's
        own connection — the result is a self-contained DB file the caller
        can open, query, and then delete (along with its parent dir).
        """
        tmp_dir = Path(tempfile.mkdtemp(prefix="pictoria-snapshot-"))
        snap_path = tmp_dir / "snapshot.duckdb"

        def _run() -> None:
            cur = state.db.cursor()
            try:
                cur.execute("CHECKPOINT")
                cur.execute("SELECT current_database()")
                source = cur.fetchone()[0]
                # snap_path is server-controlled (tempfile); source comes from DuckDB itself.
                cur.execute(f"ATTACH '{snap_path.as_posix()}' AS pictoria_snap")
                try:
                    cur.execute(f'COPY FROM DATABASE "{source}" TO pictoria_snap')
                finally:
                    cur.execute("DETACH pictoria_snap")
            finally:
                cur.close()

        await asyncio.to_thread(_run)
        logger.info(f"Created DB snapshot at {snap_path}")
        return SnapshotResult(path=str(snap_path), dir=str(tmp_dir))


async def _fetch_or_create_canonical_groups(tag_group_repo: TagGroupRepo) -> dict[str, int]:
    """Ensure canonical groups exist and return name → id mapping, ordered by priority.

    Order matters: when a tag appears under multiple types in a Danbooru post,
    the first-listed group wins (see `_persist_all` in `download_from_danbooru`).
    """
    result: dict[str, int] = {}
    for name in ("artist", "character", "copyright", "general", "meta"):
        color = TAG_GROUP_COLORS.get(name, "#000000")
        group = await tag_group_repo.ensure(name, color=color)
        result[name] = group.id
    return result
