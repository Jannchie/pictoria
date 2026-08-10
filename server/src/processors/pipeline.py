"""Pipeline orchestration: disk sync, the all-workers backfill, single-post path."""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import TYPE_CHECKING, Any

import shared
from db.repositories.posts import PostRepo
from db.repositories.vectors import VectorRepo
from processors.basics import _compute_basics_for, persist_single_basics
from processors.common import IMAGE_EXTS
from processors.registry import BASICS_WORKER, WorkerContext, context_from_connection, enabled_workers, run_worker
from progress import get_progress
from services.file_management import add_new_files, remove_deleted_files
from shared import logger
from utils import find_files_in_directory, get_path_name_and_extension

if TYPE_CHECKING:
    from pathlib import Path

    from db import DB
    from db.repositories.tags import TagGroupRepo

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

    # One connection + worker context per spec so the workers run concurrently
    # without sharing per-statement cursor state (see docstring above). Order,
    # batch sizes, and GPU-pressure flags all come from the WORKERS registry.
    specs_ctx = [(spec, context_from_connection(_checkout())) for spec in enabled_workers()]

    try:
        with get_progress() as progress:
            counts = await asyncio.gather(
                *(run_worker(spec, ctx, progress=progress) for spec, ctx in specs_ctx),
            )
        # Fire each worker's optional post-backfill hook with how many posts it
        # processed. Only the embedding worker sets one: it rebuilds near-
        # duplicate groups when new embeddings were written (skipped on an idle
        # poll, so no wasted GPU). Replaces the former hand-rolled
        # ``if any(isinstance(r, int) and r > 0 ...)`` special case.
        for (spec, _), count in zip(specs_ctx, counts, strict=True):
            if spec.on_backfill_complete is not None:
                await spec.on_backfill_complete(db, count)
    finally:
        for conn in connections:
            # discard (not plain close): keeps DB._all_conns from accumulating
            # a dead reference per worker per backfill cycle.
            db.discard_connection(conn)


async def group_near_duplicates(db: DB) -> None:
    """Rebuild near-duplicate groups on a fresh connection (logs, never raises).

    Takes ``services.dedup.rebuild_lock`` so it can't race a manual
    /v2/cmd/group-duplicates rebuild — waiting (rather than skipping) is fine
    here because the embeddings that triggered this call still deserve a
    regroup once the in-flight rebuild finishes. Called by the embedding
    worker's ``on_backfill_complete`` hook (see ``processors.registry``).
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

    # Basics first, and specially: on decode failure drop the (likely garbage)
    # upload — a bespoke twist the batch worker doesn't have, so it stays inline
    # rather than going through the registry. persist_single_basics owns the
    # one_shot palette-failure blacklist (formerly mirrored here by hand).
    try:
        basics = await asyncio.to_thread(_compute_basics_for, post, file_abs_path)
    except Exception as exc:
        if not post.sha256:
            with contextlib.suppress(OSError):
                await asyncio.to_thread(file_abs_path.unlink)
        logger.warning(f"Error processing file: {file_abs_path}: {exc}")
        return

    if basics is not None:
        await persist_single_basics(posts, post, file_abs_path, basics)

    # Every other worker runs from the registry with a single-element id list,
    # so this path shares all compute / persist code with the bulk backfill.
    # ``vectors`` is the SigLIP 2 retrieval repo (provide_vector_repo binds
    # post_vectors_siglip2), so the embedding worker encodes straight into it,
    # and the silva worker scores that embedding back out of the vec0 table.
    ctx = WorkerContext(posts=posts, vectors=vectors, tag_groups=tag_groups)
    for spec in enabled_workers():
        if spec is BASICS_WORKER:
            continue
        await spec.process_batch(ctx, [post.id])
