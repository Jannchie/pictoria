import asyncio
import contextlib
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

import duckdb
import litestar
from litestar import Controller
from litestar.datastructures import State
from litestar.exceptions import HTTPException, NotFoundException

import shared
from danbooru import DanbooruClient, DanbooruPost
from db.entities import TagGroup
from db.helpers import fetch_one_as
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

# Canonical Danbooru tag categories, ordered by priority. When a tag appears
# in multiple `tag_string_*` fields on a post, the first-listed group wins.
CANONICAL_TAG_GROUPS: tuple[str, ...] = ("artist", "character", "copyright", "general", "meta")

SUPPORTED_IMAGE_EXTS: frozenset[str] = frozenset(
    {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"},
)

# Windows forbids these in filename components; Danbooru tags like `re:rin`
# would otherwise fail mkdir on win32.
_FS_ILLEGAL_CHARS: frozenset[str] = frozenset('<>:"/\\|?*')


def _safe_dir_name(name: str) -> str:
    sanitized = "".join("_" if c in _FS_ILLEGAL_CHARS or c < " " else c for c in name)
    return sanitized.rstrip(". ") or "_"


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
        state: State,
        posts: PostRepo,
        tags: str,
    ) -> DanbooruDownloadStats:
        """Download posts from Danbooru and persist them.

        Optimization notes:
        - Shared `DanbooruClient` and the canonical tag-group map both come
          from `state` (set up once at startup) so each call avoids the API-
          client construction + five tag-group upsert round-trips it would
          otherwise repeat.
        - DB lookup, then download only the subset of `filtered` that's not
          yet in the DB — under normal operation DB membership implies file-
          on-disk, so this short-circuits the 16-worker threadpool entirely
          when nothing is new.
        """
        client: DanbooruClient = state.danbooru_client
        type_to_group_id: dict[str, int] = state.canonical_tag_groups

        danbooru_dir = shared.target_dir / "danbooru"
        save_dir = danbooru_dir / _safe_dir_name(tags)
        posts_orig = await asyncio.to_thread(client.get_posts, tags=tags, limit=99999)
        posts_with_url = [p for p in posts_orig if p.file_url]
        logger.info(f"Fetched {len(posts_with_url)} available posts ({len(posts_orig)} total)")

        filtered = [
            p
            for p in posts_with_url
            if p.file_url and p.file_ext and p.file_ext.lower() in SUPPORTED_IMAGE_EXTS
        ]
        await asyncio.to_thread(save_dir.mkdir, parents=True, exist_ok=True)
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

        # Pre-compute per-post tag maps (in-memory, no DB calls).
        precomputed_tag_maps = [_build_tag_to_group(p, type_to_group_id) for p in to_persist]

        await asyncio.to_thread(
            _persist_danbooru_batch,
            posts,
            file_path_str,
            to_persist,
            precomputed_tag_maps,
        )

        # Pass `to_persist` (not `filtered`) to download_posts: every entry in
        # `filtered \ to_persist` is already in the DB, which under normal
        # operation means its file is on disk. Skipping it avoids a wasted
        # exists() round trip per post, and short-circuits the 16-worker
        # threadpool entirely when nothing new needs downloading.
        if to_persist:
            dl_stats = await asyncio.to_thread(client.download_posts, to_persist, save_dir)
        else:
            dl_stats = {"downloaded": 0, "skipped": 0, "failed": 0}

        return DanbooruDownloadStats(
            total=len(posts_orig),
            with_url=len(posts_with_url),
            filtered=len(filtered),
            downloaded=dl_stats.get("downloaded", 0),
            skipped=(len(filtered) - len(to_persist)) + dl_stats.get("skipped", 0),
            failed=dl_stats.get("failed", 0),
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


def _persist_danbooru_batch(
    posts: PostRepo,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    """Persist a batch of Danbooru posts + their tags in two transactions.

    Split rationale: when concurrent /download-from-danbooru requests all
    insert overlapping tags, the commit-time uniqueness check on `tags(name)`
    aborts one of them. Running tag inserts in their own short transaction
    keeps that retry surface tiny and prevents replay of the (much larger)
    posts + post_has_tag work each time tags happen to conflict.

    Each transaction uses ON CONFLICT for in-snapshot duplicates and a
    bounded retry loop for commit-time conflicts that only show up against
    rows committed by other transactions after our snapshot was taken.
    """
    if not to_persist:
        return
    cur = posts.cur

    # Phase A: globally-deduped tag upsert in its own short transaction.
    all_tags: dict[str, int] = {}
    for tag_map in precomputed_tag_maps:
        for name, gid in tag_map.items():
            all_tags.setdefault(name, gid)
    if all_tags:
        _run_with_retry(cur, "tags", lambda: _insert_tags_tx(cur, all_tags))

    # Phase B: posts + post_has_tag in their own transaction. The tags they
    # reference are now committed by phase A, so concurrent writers can't
    # make this transaction wait on them.
    _run_with_retry(
        cur,
        "posts",
        lambda: _insert_posts_and_links_tx(cur, file_path_str, to_persist, precomputed_tag_maps),
    )


def _run_with_retry(
    cur: duckdb.DuckDBPyConnection,
    label: str,
    fn: Callable[[], None],
    *,
    max_attempts: int = 5,
) -> None:
    for attempt in range(1, max_attempts + 1):
        try:
            fn()
        except duckdb.TransactionException as exc:
            _safe_rollback(cur)
            if attempt == max_attempts:
                raise
            logger.warning(
                f"Danbooru {label} commit conflict (attempt {attempt}/{max_attempts}): {exc}; retrying",
            )
        except Exception:
            _safe_rollback(cur)
            raise
        else:
            return


def _insert_tags_tx(cur: duckdb.DuckDBPyConnection, all_tags: dict[str, int]) -> None:
    cur.execute("BEGIN")
    cur.executemany(
        "INSERT INTO tags(name, group_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        list(all_tags.items()),
    )
    cur.execute("COMMIT")


def _insert_posts_and_links_tx(
    cur: duckdb.DuckDBPyConnection,
    file_path_str: str,
    to_persist: list[DanbooruPost],
    precomputed_tag_maps: list[dict[str, int]],
) -> None:
    cur.execute("BEGIN")
    post_tag_pairs: list[tuple[int, dict[str, int]]] = []
    for d_post, tag_map in zip(to_persist, precomputed_tag_maps, strict=True):
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
        if row:
            post_tag_pairs.append((int(row[0]), tag_map))

    # (post_id, tag_name) is unique within this batch — each post_id appears
    # once and per-post names were deduped via dict in the pre-compute step.
    post_tag_rows = [(post_id, name) for post_id, tag_map in post_tag_pairs for name in tag_map]
    if post_tag_rows:
        cur.executemany(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, FALSE) ON CONFLICT DO NOTHING",
            post_tag_rows,
        )
    cur.execute("COMMIT")


def _safe_rollback(cur: duckdb.DuckDBPyConnection) -> None:
    """ROLLBACK that swallows the 'no transaction is active' case.

    DuckDB auto-aborts a transaction when its commit fails, so an explicit
    ROLLBACK in the except handler would raise a secondary TransactionException
    that masks the original error.
    """
    with contextlib.suppress(duckdb.TransactionException):
        cur.execute("ROLLBACK")


def _build_tag_to_group(d_post: DanbooruPost, type_to_group_id: dict[str, int]) -> dict[str, int]:
    """Collect (tag_name → group_id) from a Danbooru post's tag_string_* fields.

    `type_to_group_id` is ordered by priority; setdefault keeps the first
    (highest-priority) group when a tag appears under multiple types.
    """
    tag_to_group: dict[str, int] = {}
    for t, gid in type_to_group_id.items():
        # str.split() with no args also drops empty entries
        for tag_str in getattr(d_post, f"tag_string_{t}").split():
            tag_to_group.setdefault(tag_str, gid)
    return tag_to_group


def ensure_canonical_tag_groups_sync(cur: duckdb.DuckDBPyConnection) -> dict[str, int]:
    """Upsert the five canonical tag groups and return name → id, ordered by priority.

    Used at server startup so per-request handlers can read the cached map
    from app.state instead of re-running INSERT-then-SELECT on every call.
    """
    result: dict[str, int] = {}
    for name in CANONICAL_TAG_GROUPS:
        color = TAG_GROUP_COLORS.get(name, "#000000")
        cur.execute(
            "INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT DO NOTHING",
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


