import asyncio
import contextlib
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

import litestar
from litestar import Controller
from litestar.datastructures import State

import shared
from db.entities import TagGroup
from db.helpers import fetch_one_as
from db.queries.post_query import PostQueryService
from db.repositories.posts import PostRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from scheme import PostDetailPublic, Result, UrlImportStatus
from server.exceptions import MissingConfigError, NotAnImageError, PostNotFoundError
from server.utils import is_image
from services.danbooru_import import DanbooruDownloadStats, import_danbooru_posts
from services.gallery_dl_import import import_from_url as run_url_import
from services.wd_tagging import TAG_GROUP_COLORS, attach_wdtagger_results, get_tagger
from shared import logger
from utils import from_rating_to_int

if TYPE_CHECKING:
    from collections.abc import Coroutine

    from db import DB

# Canonical Danbooru tag categories, ordered by priority. When a tag appears
# in multiple `tag_string_*` fields on a post, the first-listed group wins.
CANONICAL_TAG_GROUPS: tuple[str, ...] = ("artist", "character", "copyright", "general", "meta")

@dataclass
class SnapshotResult:
    path: str
    dir: str


def _spawn_tracked(state: State, coro: "Coroutine[None, None, None]") -> None:
    """Run ``coro`` as a fire-and-forget task tracked in ``state.background_tasks``.

    Tracked tasks are drained by the lifespan's graceful shutdown; the done
    callback keeps the set from growing unboundedly.
    """
    task = asyncio.create_task(coro)
    state.background_tasks.add(task)
    task.add_done_callback(state.background_tasks.discard)


def _spawn_sync_metadata(state: State) -> bool:
    """Fire-and-forget the disk-scan + backfill pipeline; False if already running.

    The ``backfill_lock`` check-then-spawn is race-free on the single event
    loop, so a second caller (endpoint or post-import trigger) becomes a no-op
    instead of kicking off duplicate GPU work.
    """
    lock: asyncio.Lock = state.backfill_lock
    if lock.locked():
        return False

    async def _run() -> None:
        from processors import sync_metadata  # noqa: PLC0415  # lazy: defer ML stack load

        async with lock:
            try:
                await sync_metadata(state.db)
            except Exception:
                logger.exception("Manual metadata sync failed")

    _spawn_tracked(state, _run())
    return True


def _find_gallery_dl_conf() -> str | None:
    """Optional gallery-dl.conf (kemono cookies / UA) at <target_dir>/.pictoria/."""
    conf = shared.target_dir / ".pictoria" / "gallery-dl.conf"
    return str(conf) if conf.is_file() else None


class CommandController(Controller):
    path = "/cmd"
    tags: ClassVar[list[str]] = ["Commands"]  # type: ignore

    @litestar.put("/auto-caption/{post_id:int}")
    async def auto_caption(self, posts: PostRepo, post_query: PostQueryService, post_id: int) -> PostDetailPublic:
        post = await posts.get(post_id)
        if post is None:
            raise PostNotFoundError(post_id)
        if shared.openai_key is None:
            raise MissingConfigError("OpenAI API key is not set.")  # noqa: EM101, TRY003
        if shared.caption_annotator is None:
            from ai.make_captions import OpenAIImageAnnotator  # noqa: PLC0415  # lazy: defer ML stack load until first use

            shared.caption_annotator = OpenAIImageAnnotator(shared.openai_key)

        caption = await asyncio.to_thread(shared.caption_annotator.annotate_image, post.absolute_path)
        await posts.update_field(post_id, "caption", caption)
        return PostDetailPublic.model_validate(await post_query.get_detail(post_id))

    @litestar.put("/auto-tags/{post_id:int}", description="Auto tag a post")
    async def auto_tags(
        self,
        posts: PostRepo,
        post_query: PostQueryService,
        tag_group_repo: TagGroupRepo,
        post_id: int,
    ) -> PostDetailPublic:
        post = await posts.get(post_id)
        if post is None:
            raise PostNotFoundError(post_id)

        tagger = get_tagger()
        resp = await asyncio.to_thread(tagger.tag, post.absolute_path)
        await posts.update_field(post_id, "rating", from_rating_to_int(resp.rating))
        await attach_wdtagger_results(posts, tag_group_repo, post_id, resp, is_auto=True)
        return PostDetailPublic.model_validate(await post_query.get_detail(post_id))

    @litestar.put("/auto-tags")
    async def auto_tags_all(self, posts: PostRepo, tag_group_repo: TagGroupRepo) -> None:
        """Batch auto-tag every post that hasn't been rated yet."""
        batch_size = 32
        tagger = get_tagger()
        last_id = 0

        while True:

            def _next_batch(_last_id: int = last_id) -> list[dict]:
                posts.cur.execute(
                    "SELECT id, file_path, file_name, extension FROM posts WHERE rating = 0 AND id > ? ORDER BY id LIMIT ?",
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
    async def get_waifu_scorer_one(self, posts: PostRepo, scores: ScoreRepo, post_id: int) -> float:
        """Compute (and persist) the waifu score for a single post."""
        post = await posts.get(post_id)
        if post is None:
            raise PostNotFoundError(post_id)
        if not is_image(post.absolute_path):
            raise NotAnImageError(post_id)
        existing = await scores.get_waifu_score(post_id)
        if existing is not None:
            return existing
        from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer ML stack load until first use

        scorer = get_waifu_scorer()
        result = await asyncio.to_thread(scorer, [post.absolute_path])
        score = float(result[0]) if isinstance(result, (list, tuple)) else float(result)
        await scores.upsert_waifu_score(post_id, score)
        return score

    @litestar.put("/silva-scorer")
    async def auto_silva_scorer(self, state: State) -> None:
        """Batch-score all posts that have a SigLIP2 embedding but no SILVA score."""
        from processors import run_silva_worker  # noqa: PLC0415  # lazy: defer ML stack load
        from progress import get_progress  # noqa: PLC0415

        db: DB = state.db
        conn = db.new_connection()
        try:
            with get_progress() as progress:
                await run_silva_worker(
                    PostRepo(conn.cursor()),
                    VectorRepo(conn.cursor(), table="post_vectors_siglip2", dim=1152),
                    progress=progress,
                )
        finally:
            with contextlib.suppress(Exception):
                conn.close()

    @litestar.get("/silva-scorer/{post_id:int}")
    async def get_silva_scorer_one(
        self, posts: PostRepo, scores: ScoreRepo, vectors: VectorRepo, post_id: int,
    ) -> float:
        """Compute (and persist) the SILVA score for one post from its embedding.

        Reuses the stored SigLIP2 embedding; if the post has none yet, computes
        and stores the embedding first so the score is available immediately.
        """
        post = await posts.get(post_id)
        if post is None:
            raise PostNotFoundError(post_id)
        if not is_image(post.absolute_path):
            raise NotAnImageError(post_id)
        from ai.silva_scorer import SCORER_NAME, score_embeddings  # noqa: PLC0415  # lazy: defer ML stack load

        existing = await scores.get_aesthetic_score(post_id, SCORER_NAME)
        if existing is not None:
            return existing

        embedding = await vectors.get(post_id)
        if embedding is None:
            import numpy as np  # noqa: PLC0415

            from ai.siglip_embed import calculate_image_features  # noqa: PLC0415

            features = await asyncio.to_thread(calculate_image_features, post.absolute_path)
            embedding = features.cpu().numpy()[0].astype(np.float32)
            await vectors.upsert(post_id, embedding)

        score = float((await asyncio.to_thread(score_embeddings, [embedding]))[0])
        await scores.upsert_aesthetic_score(post_id, SCORER_NAME, score)
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
        state: State,
        tags: str,
    ) -> DanbooruDownloadStats:
        """Download posts from Danbooru and persist them (see ``import_danbooru_posts``)."""
        return await import_danbooru_posts(
            client=state.danbooru_client,
            type_to_group_id=state.canonical_tag_groups,
            db=state.db,
            tags=tags,
            executor=getattr(state, "io_executor", None),
        )

    @litestar.post(
        "/import-from-url",
        description="Fetch a creator/tag URL via gallery-dl in the background and persist new images",
    )
    async def import_from_url_endpoint(self, state: State, url: str) -> Result:
        """Start a background gallery-dl import of every new image behind ``url``.

        Fire-and-forget like ``sync-metadata``: the fetch (gallery-dl pagination)
        plus download can run for many minutes, so the request returns
        immediately and the frontend polls ``GET /import-from-url/status``.
        Only one import runs at a time; a fresh ``running`` status object is
        published to ``app.state`` *synchronously* so the busy-check is
        race-free on the event loop.
        """
        if state.url_import_status.state == "running":
            return Result(msg="Import already running")

        status = UrlImportStatus(
            state="running",
            url=url,
            started_at=datetime.now(tz=UTC).isoformat(timespec="seconds"),
        )
        state.url_import_status = status

        async def _run() -> None:
            db: DB = state.db
            conn = db.new_connection()
            try:
                stats = await asyncio.to_thread(
                    run_url_import,
                    url,
                    db=conn,
                    type_to_group_id=state.canonical_tag_groups,
                    apply=True,
                    config_path=_find_gallery_dl_conf(),
                )
            except Exception as exc:
                logger.exception(f"URL import failed for {url}")
                status.state = "failed"
                status.error = str(exc)
            else:
                status.state = "done"
                status.stats = stats
                # New images need embedding / scores / auto-tags (kemono posts
                # carry no tags at all) — kick the existing backfill pipeline.
                status.sync_triggered = _spawn_sync_metadata(state)
            finally:
                status.finished_at = datetime.now(tz=UTC).isoformat(timespec="seconds")
                db.discard_connection(conn)

        _spawn_tracked(state, _run())
        return Result(msg="Import started")

    @litestar.get(
        "/import-from-url/status",
        description="Status of the current/last background URL import",
    )
    async def import_from_url_status(self, state: State) -> UrlImportStatus:
        return state.url_import_status

    @litestar.post("/sync-metadata", description="Rescan target_dir and run every backfill worker")
    async def sync_metadata_endpoint(self, state: State) -> Result:
        """Trigger the same disk-scan + all-workers pipeline that runs at startup.

        Fire-and-forget: returns immediately so the HTTP client doesn't sit
        waiting on a multi-minute scan. The ``backfill_lock`` makes a second
        call a no-op while the first is still running, so spam-clicking this
        endpoint (or hitting it while the startup backfill is mid-flight)
        won't kick off duplicate GPU work.
        """
        if not _spawn_sync_metadata(state):
            return Result(msg="Sync already running")
        return Result(msg="Sync started")

    @litestar.post(
        "/group-duplicates",
        description="Rebuild near-duplicate groups (posts.canonical_post_id) from SigLIP2 similarity.",
    )
    async def group_duplicates(self, state: State, threshold: float | None = None) -> Result:
        """Recompute every post's near-duplicate group in the background.

        Fire-and-forget on a fresh connection (the rebuild does one KNN per
        embedded post, so on a large library it runs for minutes): returns
        immediately and logs the member count when done. ``threshold`` overrides
        the default cosine-distance ceiling for tuning; smaller = stricter.
        """
        from services.dedup import DEFAULT_DEDUP_THRESHOLD, rebuild_groups  # noqa: PLC0415

        db: DB = state.db
        thr = DEFAULT_DEDUP_THRESHOLD if threshold is None else threshold

        async def _run() -> None:
            conn = db.new_connection()
            try:
                await rebuild_groups(
                    PostRepo(conn.cursor()),
                    VectorRepo(conn.cursor(), table="post_vectors_siglip2", dim=1152),
                    threshold=thr,
                )
            except Exception:
                logger.exception("Near-duplicate grouping failed")
            finally:
                with contextlib.suppress(Exception):
                    conn.close()

        _spawn_tracked(state, _run())
        return Result(msg=f"Near-duplicate grouping started (threshold={thr}).")

    @litestar.post("/db/snapshot", description="Create a point-in-time SQLite snapshot for offline tooling")
    async def db_snapshot(self, state: State) -> SnapshotResult:
        """Snapshot the live DB to a tempfile so external readers can open it.

        SQLite supports ``VACUUM INTO`` which produces a self-contained,
        consistent copy of the live database into a new file — works while
        writers are active (it transparently uses a read transaction).
        Caller can open, query, and then delete the snapshot dir.
        """
        tmp_dir = Path(tempfile.mkdtemp(prefix="pictoria-snapshot-"))
        snap_path = tmp_dir / "snapshot.sqlite"

        def _run() -> None:
            cur = state.db.cursor()
            try:
                # snap_path is server-controlled (tempfile); single-quote-safe
                # because mkdtemp returns a path with no quotes.
                cur.execute(f"VACUUM INTO '{snap_path.as_posix()}'")
            finally:
                cur.close()

        await asyncio.to_thread(_run)
        logger.info(f"Created DB snapshot at {snap_path}")
        return SnapshotResult(path=str(snap_path), dir=str(tmp_dir))


def ensure_canonical_tag_groups_sync(cur: sqlite3.Cursor) -> dict[str, int]:
    """Upsert the five canonical tag groups and return name → id, ordered by priority.

    Used at server startup so per-request handlers can read the cached map
    from app.state instead of re-running INSERT-then-SELECT on every call.
    """
    result: dict[str, int] = {}
    for name in CANONICAL_TAG_GROUPS:
        color = TAG_GROUP_COLORS.get(name, "#000000")
        cur.execute(
            "INSERT INTO tag_groups(name, color) VALUES (?, ?) "
            "ON CONFLICT(name) DO NOTHING",
            [name, color],
        )
        cur.execute(
            "SELECT id, name, parent_id, color, created_at, updated_at FROM tag_groups WHERE name = ?",
            [name],
        )
        tg = fetch_one_as(cur, TagGroup)
        if tg is None:
            msg = f"TagGroup upsert failed for: {name}"
            raise RuntimeError(msg)
        result[name] = tg.id
    return result


