"""Pipeline orchestration: disk sync, the all-workers backfill, single-post path."""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import TYPE_CHECKING, Any

import shared
from db.repositories.failures import WORKER_BASICS, FailureRepo
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from processors.basics import _compute_basics_for, _persist_basics_batch, run_basics_worker
from processors.common import IMAGE_EXTS
from processors.embedding import _process_siglip_embedding_batch, run_siglip_embedding_worker
from processors.scoring import _process_silva_batch, _process_waifu_batch, run_silva_worker, run_waifu_worker
from processors.tagger import _process_tagger_batch, run_tagger_worker
from progress import get_progress
from services.file_management import add_new_files, remove_deleted_files
from shared import logger
from utils import find_files_in_directory, get_path_name_and_extension

if TYPE_CHECKING:
    from pathlib import Path

    from db import DB

# Process-wide cache for find_files_in_directory: each entry maps an absolute
# directory path to (mtime_ns, [direct files]). Survives across sync_metadata
# polls (the poller runs every 60 s) so unchanged subtrees skip rescanning.
# Lost on restart by design — the first scan after boot is always a cold
# walk, which is fine because the rest of startup dominates that cost.
_scan_cache: dict[str, tuple[int, list[tuple[str, str, str]]]] = {}


async def sync_metadata(db: DB) -> None:
    """Reconcile disk vs DB, then run every backfill worker concurrently."""
    # Walk the filesystem off the event loop — a 155k-file scan takes long
    # enough that running it inline freezes every concurrent HTTP request
    # until the scan finishes. After the first cold scan, the per-process
    # _scan_cache lets unchanged subdirectories skip their direct-file
    # scandir; on a 150k-file library where 99% of dirs are unchanged
    # between polls, this turns every subsequent poll into a sub-second walk.
    t0 = time.perf_counter()
    os_tuples = await asyncio.to_thread(
        find_files_in_directory,
        shared.target_dir,
        _scan_cache,
    )
    logger.info(f"[sync] find_files_in_directory: {time.perf_counter() - t0:.2f}s")

    cur = db.cursor()
    try:
        posts = PostRepo(cur)

        def _existing() -> dict[tuple[str, str, str], int]:
            cur.execute("SELECT id, file_path, file_name, extension FROM posts")
            return {(r[1], r[2], r[3]): r[0] for r in cur.fetchall()}

        db_path_to_id = await asyncio.to_thread(_existing)
        db_tuples_set = set(db_path_to_id.keys())
        os_tuples_set = set(os_tuples)
        logger.info(f"DB has {len(db_tuples_set)} files, disk has {len(os_tuples_set)}")

        await remove_deleted_files(posts, os_tuples_set=os_tuples_set, db_path_to_id=db_path_to_id)
        await add_new_files(posts, os_tuples_set=os_tuples_set, db_tuples_set=db_tuples_set)
    finally:
        with contextlib.suppress(Exception):
            cur.close()

    await run_all_backfill(db)


async def run_all_backfill(db: DB) -> None:
    """Run every backfill worker concurrently with a shared progress display.

    Each worker gets its OWN sqlite3 connection — *not just its own cursor*.
    Python's sqlite3 module gives every cursor its own ``description`` /
    result-row state, but when multiple cursors on the same connection are
    driven from multiple ``asyncio.to_thread`` worker threads in parallel,
    that per-cursor state can desync from the statement that was actually
    executed (we saw ``fetchone()`` return mostly-NULL rows whose layout
    didn't match the SELECT). A dedicated per-worker connection isolates
    the statement/row state entirely. Multiple cursors *within* one worker
    share a connection safely because ``await`` serialises that worker's
    calls.
    """
    connections: list[Any] = []

    def _checkout() -> Any:
        conn = db.new_connection()
        connections.append(conn)
        return conn

    basics_conn = _checkout()
    tagger_conn = _checkout()
    waifu_conn = _checkout()
    # SILVA aesthetic backfill: scores stored SigLIP2 embeddings (no image
    # decode / backbone), so it scoops up every post that has an embedding but
    # no silva score yet — including the existing library.
    silva_conn = _checkout()
    # SigLIP 2 retrieval-embedding backfill — the sole search/retrieval
    # embedding worker now that CLIP retrieval has been removed.
    siglip_embed_conn = _checkout()

    try:
        with get_progress() as progress:
            workers = [
                run_basics_worker(
                    PostRepo(basics_conn.cursor()),
                    progress=progress,
                ),
                run_siglip_embedding_worker(
                    PostRepo(siglip_embed_conn.cursor()),
                    VectorRepo(siglip_embed_conn.cursor()),
                    progress=progress,
                ),
                run_tagger_worker(
                    PostRepo(tagger_conn.cursor()),
                    TagGroupRepo(tagger_conn.cursor()),
                    progress=progress,
                ),
                run_waifu_worker(
                    PostRepo(waifu_conn.cursor()),
                    progress=progress,
                ),
                run_silva_worker(
                    PostRepo(silva_conn.cursor()),
                    VectorRepo(silva_conn.cursor()),
                    progress=progress,
                ),
            ]
            results = await asyncio.gather(*workers)
        # Only run_siglip_embedding_worker returns an int (posts embedded this
        # run). If it added any, rebuild near-duplicate groups now that the
        # embeddings exist — one GPU matrix-multiply pass, idempotent. On a cold
        # first backfill this auto-groups the whole existing library; on a sync
        # that added a few posts it re-groups from the (now slightly larger) set.
        # An idle poll embeds nothing, so this is skipped — no wasted GPU.
        if any(isinstance(r, int) and r > 0 for r in results):
            await _group_near_duplicates(db)
    finally:
        for conn in connections:
            # discard (not plain close): keeps DB._all_conns from accumulating
            # a dead reference per worker per backfill cycle.
            db.discard_connection(conn)


async def _group_near_duplicates(db: DB) -> None:
    """Rebuild near-duplicate groups on a fresh connection (logs, never raises).

    Takes ``services.dedup.rebuild_lock`` so it can't race a manual
    /v2/cmd/group-duplicates rebuild — waiting (rather than skipping) is fine
    here because the embeddings that triggered this call still deserve a
    regroup once the in-flight rebuild finishes.
    """
    from services.dedup import rebuild_groups, rebuild_lock  # noqa: PLC0415

    async with rebuild_lock:
        conn = db.new_connection()
        try:
            await rebuild_groups(
                PostRepo(conn.cursor()),
                VectorRepo(conn.cursor()),
            )
        except Exception:
            logger.exception("Near-duplicate grouping failed")
        finally:
            db.discard_connection(conn)


async def process_post(
    posts: PostRepo,
    vectors: VectorRepo,
    tag_groups: TagGroupRepo,
    file_abs_path: Path | None = None,
) -> None:
    """Run every worker for a single freshly-uploaded post.

    Each worker's batch function is invoked with a single-element id list, so
    this path shares all compute / persist code with the bulk backfill above.
    No progress display — this is called inline from request handlers.
    """
    if file_abs_path is None:
        logger.error("file_abs_path cannot be None")
        return

    file_path, file_name, extension = get_path_name_and_extension(file_abs_path)
    post = await posts.get_by_path(file_path, file_name, extension)
    if post is None:
        logger.info(f"Post not found in database: {file_abs_path}")
        return

    if file_abs_path.suffix.lower() not in IMAGE_EXTS:
        logger.debug(f"Skipping non-image file: {file_abs_path}")
        return

    logger.info(f"Processing post: {file_abs_path}")

    # Basics first — and on decode failure, drop the (likely garbage) upload.
    try:
        basics = await asyncio.to_thread(_compute_basics_for, post, file_abs_path)
    except Exception as exc:
        if not post.sha256:
            with contextlib.suppress(OSError):
                await asyncio.to_thread(file_abs_path.unlink)
        logger.warning(f"Error processing file: {file_abs_path}: {exc}")
        return

    if basics is not None:
        await asyncio.to_thread(_persist_basics_batch, posts, [(post, file_abs_path, basics)])
        # Mirror the basics-batch path: a successful decode whose colorthief
        # step failed leaves dominant_color NULL, which would re-select the
        # post on the next sync. One-shot black-list it instead.
        if basics.get("color_error"):
            await FailureRepo(posts.cur).record_failures([(post.id, WORKER_BASICS, f"color: {basics['color_error']}")])

    # ``vectors`` is the SigLIP 2 retrieval repo (provide_vector_repo binds
    # post_vectors_siglip2), so encode the upload straight into it.
    await _process_siglip_embedding_batch(posts, vectors, [post.id])
    await _process_tagger_batch(posts, tag_groups, [post.id])
    await _process_waifu_batch(posts, [post.id])
    # Scores the embedding just written above (read back from the vec0 table),
    # so this never touches the image or the SigLIP2 backbone.
    await _process_silva_batch(posts, vectors, [post.id])
