"""Post-processing backfill, split into independent workers.

Each metadata type (basics, SigLIP 2 embedding, WDTagger tags, waifu score) is
handled by its own worker with its own ``WHERE … IS NULL`` style pending
predicate and its own progress bar. Workers run concurrently as asyncio
tasks sharing a single ``rich.Progress`` display, so the CLI shows one
bar per active worker stacked vertically.

Design notes
------------
- "Basics" stays bundled (sha256 + arthash + dimensions + palette +
  dominant_color) because all of these piggyback on a single file open
  / PIL decode — splitting them would re-decode the same image up to
  four times.
- The three GPU-ish workers (embedding / tagger / waifu) each iterate
  per-image with ``batch_size = 1`` so their progress bar advances every
  image, not every chunk.
- No per-worker thread-pool sizing: each worker just hands its sync
  payload to the global ``asyncio.to_thread`` executor as before.
- ``process_post`` (single-image entry point used by the upload route)
  runs the same per-worker batch functions for one id, without a
  progress display.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image, UnidentifiedImageError
from skimage import color

import shared
from db.repositories.failures import FailureRepo
from db.repositories.posts import PostRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from progress import get_progress
from services.file_management import add_new_files, remove_deleted_files
from shared import logger
from tools.colors import get_palette, rgb2int
from utils import (
    attach_wdtagger_results,
    attach_wdtagger_results_many,
    calculate_arthash,
    calculate_sha256,
    create_thumbnail_by_image,
    find_files_in_directory,
    from_rating_to_int,
    get_path_name_and_extension,
    get_tagger,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from pathlib import Path

    from rich.progress import Progress

    from db import DB
    from db.entities import Post


IMAGE_EXTS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"},
)

# Same extensions but without the leading dot, formatted for inlining into a
# SQL ``IN (...)`` clause. Used by every pending-query so the workers never
# enqueue ``.txt`` / ``.zip`` / etc. — those would just be filtered out
# image-by-image inside the batch processor anyway, while still ticking the
# progress bar.
_IMAGE_EXT_SQL_LIST = ", ".join(f"'{ext.lstrip('.')}'" for ext in sorted(IMAGE_EXTS))
_IMAGE_EXT_WHERE = f"LOWER(p.extension) IN ({_IMAGE_EXT_SQL_LIST})"

BASICS_BATCH_SIZE = 32
WAIFU_BATCH_SIZE = 32
# SigLIP 2 so400m is a larger ViT than CLIP-L/14; batch=16 sits in the same
# tier as the SigLIP aesthetic scorer and fits 12GB at bf16.
SIGLIP_EMBED_BATCH_SIZE = 16
# WDTagger (wd-vit-large) runs on GPU; batch=32 keeps it saturated on a
# single 30xx-class card.
TAGGER_BATCH_SIZE = 32
# SigLIP-so400m is a noticeably larger ViT than CLIP-L/14; batch=16 fits
# comfortably in 12GB at bfloat16 with the rest of the model stack loaded.
SIGLIP_BATCH_SIZE = 16
# SILVA scores stored embeddings (no image decode / backbone) — a pure head
# forward, so batches can be large and cheap.
SILVA_BATCH_SIZE = 256

# When the full GPU batch crashes (typically one unreadable image in the
# collate), we shrink to this size before going single-image. Mid-size
# batches keep the GPU usefully fed (a batch of 4 amortizes most of the
# launch / collate overhead) while bounding the blast radius of a single
# bad image to 4 retries.
FALLBACK_MINI_BATCH_SIZE = 4

# Process-wide cache for find_files_in_directory: each entry maps an absolute
# directory path to (mtime_ns, [direct files]). Survives across sync_metadata
# polls (the poller runs every 60 s) so unchanged subtrees skip rescanning.
# Lost on restart by design — the first scan after boot is always a cold
# walk, which is fine because the rest of startup dominates that cost.
_scan_cache: dict[str, tuple[int, list[tuple[str, str, str]]]] = {}


# ─── Public API ──────────────────────────────────────────────────────────


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
        find_files_in_directory, shared.target_dir, _scan_cache,
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
    # SigLIP backfill is opt-in (see shared.enable_siglip_scorer): skip
    # allocating its connection and worker coroutine entirely when disabled
    # so the GPU isn't held by a model load we'll never use.
    siglip_conn = _checkout() if shared.enable_siglip_scorer else None
    # SILVA aesthetic backfill is opt-in too (see shared.enable_silva_scorer).
    silva_conn = _checkout() if shared.enable_silva_scorer else None
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
                    VectorRepo(
                        siglip_embed_conn.cursor(),
                        table="post_vectors_siglip2",
                        dim=1152,
                    ),
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
            ]
            if siglip_conn is not None:
                workers.append(
                    run_siglip_worker(
                        PostRepo(siglip_conn.cursor()),
                        progress=progress,
                    ),
                )
            if silva_conn is not None:
                workers.append(
                    run_silva_worker(
                        PostRepo(silva_conn.cursor()),
                        VectorRepo(
                            silva_conn.cursor(),
                            table="post_vectors_siglip2",
                            dim=1152,
                        ),
                        progress=progress,
                    ),
                )
            await asyncio.gather(*workers)
    finally:
        for conn in connections:
            with contextlib.suppress(Exception):
                conn.close()


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
            await FailureRepo(posts.cur).record_failures([(post.id, "basics", f"color: {basics['color_error']}")])

    # ``vectors`` is the SigLIP 2 retrieval repo (provide_vector_repo binds
    # post_vectors_siglip2), so encode the upload straight into it.
    await _process_siglip_embedding_batch(posts, vectors, [post.id])
    await _process_tagger_batch(posts, tag_groups, [post.id])
    await _process_waifu_batch(posts, [post.id])
    if shared.enable_siglip_scorer:
        await _process_siglip_batch(posts, [post.id])
    if shared.enable_silva_scorer:
        await _process_silva_batch(posts, vectors, [post.id])


# ─── Worker drivers ─────────────────────────────────────────────────────


async def _drive(  # noqa: PLR0913
    progress: Progress | None,
    name: str,
    pending: list[int],
    batch_size: int,
    process: Callable[[list[int]], Awaitable[None]],
    *,
    gpu_adaptive: bool = False,
) -> None:
    """Iterate ``pending`` in ``batch_size`` chunks, advancing one progress task.

    A worker that wants per-image granularity sets ``batch_size = 1`` — the
    progress task then ticks after every single image without the worker
    needing direct access to ``progress``.

    Pass ``gpu_adaptive=True`` for workers whose batches live on the GPU.
    The driver samples ``torch.cuda.mem_get_info`` before each batch and
    shrinks the working size when free memory is low, so concurrent
    workers don't push each other into CUDA OOM.
    """
    if not pending:
        return
    from processors.gpu_pressure import adaptive_batch_size  # noqa: PLC0415

    task = progress.add_task(name, total=len(pending)) if progress else None
    i = 0
    while i < len(pending):
        # Graceful shutdown: the lifespan finalizer sets this before tearing
        # down DB connections, so we exit at a batch boundary instead of
        # getting interrupted mid-write and racing the close.
        if shared.shutdown_event.is_set():
            logger.info(f"[{name}] shutdown requested; stopping after {i}/{len(pending)} items")
            break
        effective_size = (
            adaptive_batch_size(batch_size, label=name)
            if gpu_adaptive
            else batch_size
        )
        batch = pending[i:i + effective_size]
        try:
            await process(batch)
        except Exception:
            logger.exception(f"[{name}] batch starting at id {batch[0]} failed")
        if progress is not None and task is not None:
            progress.update(task, advance=len(batch))
        i += len(batch)


async def run_basics_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill sha256 / arthash / dimensions / palette / dominant_color."""
    pending = await _list_basics_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_basics_batch(posts, batch_ids)

    await _drive(progress, "Basics", pending, BASICS_BATCH_SIZE, _process)


async def run_siglip_embedding_worker(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill SigLIP 2 image embeddings into post_vectors_siglip2.

    ``vectors`` must be a VectorRepo pointed at post_vectors_siglip2 (dim=1152).
    """
    pending = await vectors.list_missing_post_ids(
        image_exts=[ext.lstrip(".") for ext in IMAGE_EXTS],
        worker="embedding:siglip2",
    )

    async def _process(batch_ids: list[int]) -> None:
        await _process_siglip_embedding_batch(posts, vectors, batch_ids)

    await _drive(
        progress, "SigLIP embeddings", pending, SIGLIP_EMBED_BATCH_SIZE, _process,
        gpu_adaptive=True,
    )


async def run_tagger_worker(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill WDTagger auto-tags (and rating, if unset) per post."""
    pending = await _list_tagger_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_tagger_batch(posts, tag_groups, batch_ids)

    await _drive(
        progress, "Tags", pending, TAGGER_BATCH_SIZE, _process,
        gpu_adaptive=True,
    )


async def run_waifu_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the waifu quality score into ``post_waifu_scores``."""
    pending = await _list_waifu_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_waifu_batch(posts, batch_ids)

    await _drive(
        progress, "Waifu scorer", pending, WAIFU_BATCH_SIZE, _process,
        gpu_adaptive=True,
    )


async def run_siglip_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the SigLIP-based aesthetic score (Aesthetic Predictor V2.5)."""
    from ai.siglip_scorer import SCORER_NAME  # noqa: PLC0415  # lazy: defer ML stack load

    pending = await _list_aesthetic_pending(posts, SCORER_NAME)

    async def _process(batch_ids: list[int]) -> None:
        await _process_siglip_batch(posts, batch_ids)

    await _drive(
        progress, "SigLIP scorer", pending, SIGLIP_BATCH_SIZE, _process,
        gpu_adaptive=True,
    )


async def run_silva_worker(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the SILVA aesthetic score from stored SigLIP2 embeddings.

    Pending = posts that already have a ``post_vectors_siglip2`` embedding but no
    ``silva`` score yet. Scoring reuses that embedding (see ``ai.silva_scorer``),
    so this worker never opens the image files or loads the SigLIP2 backbone.
    """
    from ai.silva_scorer import SCORER_NAME  # noqa: PLC0415  # lazy: defer ML stack load

    pending = await _list_silva_pending(posts, SCORER_NAME)

    async def _process(batch_ids: list[int]) -> None:
        await _process_silva_batch(posts, vectors, batch_ids)

    await _drive(progress, "SILVA scorer", pending, SILVA_BATCH_SIZE, _process)


# ─── Pending queries ────────────────────────────────────────────────────


async def _list_basics_pending(posts: PostRepo) -> list[int]:
    # When arthash is disabled, drop the ``arthash IS NULL`` predicate — otherwise
    # every legacy post whose only missing column is arthash would be selected
    # on every sync, but the worker would no-op on it (because _compute_basics_for
    # also short-circuits arthash), and the same ids would be re-picked next pass.
    arthash_clause = "" if shared.disable_arthash else "OR p.arthash IS NULL OR p.arthash = ''"

    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE (p.sha256 = ''
                {arthash_clause}
                OR p.dominant_color IS NULL)
              AND {_IMAGE_EXT_WHERE}
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = 'basics'
              )
            ORDER BY p.id
            """,  # noqa: S608
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_tagger_pending(posts: PostRepo) -> list[int]:
    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE NOT EXISTS (
                SELECT 1 FROM post_has_tag pht
                WHERE pht.post_id = p.id AND pht.is_auto = 1
            )
              AND {_IMAGE_EXT_WHERE}
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = 'tagger'
              )
            ORDER BY p.id
            """,  # noqa: S608
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_waifu_pending(posts: PostRepo) -> list[int]:
    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id
            WHERE pws.post_id IS NULL
              AND {_IMAGE_EXT_WHERE}
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = 'waifu'
              )
            ORDER BY p.id
            """,  # noqa: S608
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_aesthetic_pending(posts: PostRepo, scorer: str) -> list[int]:
    """Pending posts for an entry in ``post_aesthetic_scores`` keyed by scorer.

    The failure-blacklist worker name is ``aesthetic:<scorer>`` so each scorer
    has its own one-shot failure log instead of sharing a single bucket.
    """

    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            LEFT JOIN post_aesthetic_scores pas
              ON pas.post_id = p.id AND pas.scorer = ?
            WHERE pas.post_id IS NULL
              AND {_IMAGE_EXT_WHERE}
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = ?
              )
            ORDER BY p.id
            """,  # noqa: S608
            [scorer, f"aesthetic:{scorer}"],
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_silva_pending(posts: PostRepo, scorer: str) -> list[int]:
    """Posts that have a SigLIP2 embedding but no ``scorer`` aesthetic score.

    Unlike ``_list_aesthetic_pending``, SILVA scores the *embedding*, not the
    image, so it requires one to exist. The ``EXISTS`` against
    post_vectors_siglip2 is a per-post primary-key lookup on the vec0 table (the
    same ``WHERE post_id = ?`` access VectorRepo.get uses) — not a vector scan —
    so it stays fast on a large library.
    """

    def _impl() -> list[int]:
        posts.cur.execute(
            """
            SELECT p.id FROM posts p
            WHERE EXISTS (
                SELECT 1 FROM post_vectors_siglip2 pv WHERE pv.post_id = p.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM post_aesthetic_scores pas
                WHERE pas.post_id = p.id AND pas.scorer = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = ?
              )
            ORDER BY p.id
            """,
            [scorer, f"aesthetic:{scorer}"],
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


# ─── Per-worker batch processors ────────────────────────────────────────


async def _process_basics_batch(posts: PostRepo, post_ids: list[int]) -> None:  # noqa: C901
    """Resolve paths, decode each image once, write back basics in one batch."""
    posts_map = await posts.get_many(post_ids)
    items: list[tuple[Post, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS:
            continue
        if not abs_path.exists():
            continue
        items.append((post, abs_path))
    if not items:
        return

    raw_results = await asyncio.gather(
        *[asyncio.to_thread(_compute_basics_for, post, path) for post, path in items],
        return_exceptions=True,
    )
    valid: list[tuple[Post, Path, dict]] = []
    failed: list[tuple[int, str, str]] = []
    for (post, path), b in zip(items, raw_results, strict=True):
        if isinstance(b, BaseException):
            logger.warning(f"[basics] compute failed for {path}: {b}")
            failed.append((post.id, "basics", f"compute failed: {b}"))
            continue
        if b is None:
            continue
        # PIL decoded fine but colorthief couldn't extract a palette — other
        # basics fields still get persisted, but ``dominant_color`` stays
        # NULL. Without a failure row, the post would be re-selected on
        # every sync forever; the blacklist makes it one-shot.
        if b.get("color_error"):
            failed.append((post.id, "basics", f"color: {b['color_error']}"))
        valid.append((post, path, b))
    if valid:
        await asyncio.to_thread(_persist_basics_batch, posts, valid)
    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


async def _process_siglip_embedding_batch(  # noqa: C901, PLR0912
    posts: PostRepo,
    vectors: VectorRepo,
    post_ids: list[int],
) -> None:
    """Encode a batch into SigLIP 2 embeddings written to post_vectors_siglip2.

    On a whole-batch forward failure it first shrinks to mini-batches, then to
    single-image; an unreadable single image is recorded under the
    'embedding:siglip2' one-shot blacklist. ``vectors`` must be a VectorRepo
    pointed at post_vectors_siglip2 (dim=1152).
    """
    from ai.siglip_embed import (  # noqa: PLC0415  # lazy: defer ML stack load
        calculate_image_features,
        calculate_image_features_batch,
    )

    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, abs_path))
    if not items:
        return

    paths = [p for _, p in items]
    try:
        features = await asyncio.to_thread(calculate_image_features_batch, paths)
    except Exception as exc:
        logger.warning(
            f"[siglip-embedding] batch failed ({exc!s}); "
            f"retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
        failed: list[tuple[int, str, str]] = []
        for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
            chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
            chunk_paths = [p for _, p in chunk]
            try:
                chunk_features = await asyncio.to_thread(
                    calculate_image_features_batch, chunk_paths,
                )
            except Exception as exc2:
                logger.warning(
                    f"[siglip-embedding] mini-batch failed ({exc2!s}); falling back per-image",
                )
                for pid, path in chunk:
                    try:
                        single = await asyncio.to_thread(calculate_image_features, path)
                        embedding = single.cpu().numpy()[0].astype(np.float32)
                        await vectors.upsert(pid, embedding)
                    except (UnidentifiedImageError, OSError) as exc3:
                        logger.warning(f"[siglip-embedding] skipping unreadable image {pid} ({path}): {exc3}")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
                    except Exception as exc3:
                        logger.exception(f"[siglip-embedding] post {pid} ({path})")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
            else:
                embeddings_np = chunk_features.cpu().numpy().astype(np.float32)
                for (pid, _), emb in zip(chunk, embeddings_np, strict=True):
                    await vectors.upsert(pid, emb)
        if failed:
            await FailureRepo(posts.cur).record_failures(failed)
        return

    embeddings_np = features.cpu().numpy().astype(np.float32)
    for (pid, _), emb in zip(items, embeddings_np, strict=True):
        await vectors.upsert(pid, emb)


async def _process_tagger_batch(  # noqa: C901
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    post_ids: list[int],
) -> None:
    tagger = get_tagger()
    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Post, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, post, abs_path))
    if not items:
        return

    paths = [p for _, _, p in items]
    try:
        results = await asyncio.to_thread(tagger.tag, paths)
    except Exception as exc:
        # WDTagger collates the whole list before running; one bad image kills
        # the batch. Try mini-batches first to keep the GPU usefully busy, and
        # only drop the bad mini-batch to per-image.
        logger.warning(
            f"[tagger] batch failed ({exc!s}); "
            f"retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
        await _tagger_fallback_mini_batch(posts, tag_groups, items)
        return

    rating_updates: list[tuple[int, int]] = []
    tag_items: list[tuple[int, Any]] = []
    failed: list[tuple[int, str, str]] = []
    early_failed: set[int] = set()
    for (pid, post, _), resp in zip(items, results, strict=True):
        # An empty result would leave post_has_tag untouched, so the
        # post stays pending forever. Black-list it instead — re-running
        # would just produce the same empty response.
        if not resp.general_tags and not resp.character_tags:
            failed.append((pid, "tagger", "no auto tags produced"))
            early_failed.add(pid)
            continue
        new_rating = from_rating_to_int(resp.rating)
        if post.rating == 0 and new_rating != 0:
            rating_updates.append((pid, new_rating))
        tag_items.append((pid, resp))

    if rating_updates:
        await asyncio.to_thread(_update_ratings, posts, rating_updates)
    await attach_wdtagger_results_many(posts, tag_groups, tag_items, is_auto=True)

    # Post-persist sanity check: ``attach_wdtagger_results_many`` issues
    # ``INSERT ... ON CONFLICT (post_id, tag_name) DO NOTHING``, so when
    # *every* tag the tagger produced for a post was already present as a
    # manual (``is_auto=0``) row — common for Danbooru-imported images —
    # zero ``is_auto=1`` rows get created and the pending predicate
    # re-selects the post on every sync. Black-list those too: re-running
    # the tagger produces the same shadowed result.
    attempted = [pid for pid, _, _ in items if pid not in early_failed]
    if attempted:
        shadowed = await _find_posts_without_auto_tags(posts, attempted)
        failed.extend((pid, "tagger", "all auto tags shadowed by manual tags") for pid in shadowed)

    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


async def _find_posts_without_auto_tags(posts: PostRepo, post_ids: list[int]) -> list[int]:
    """Return ids from ``post_ids`` that still have no ``is_auto=1`` row.

    Used as a post-persist verification step in the tagger workers: the
    INSERT-OR-NOTHING semantics of ``post_has_tag`` silently swallow inserts
    that collide with pre-existing manual tags, so the auto-tag rows aren't
    materialised even though the tagger did run.
    """

    def _impl() -> list[int]:
        placeholders = ",".join("?" * len(post_ids))
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE p.id IN ({placeholders})
              AND NOT EXISTS (
                SELECT 1 FROM post_has_tag pht
                WHERE pht.post_id = p.id AND pht.is_auto = 1
              )
            """,  # noqa: S608
            post_ids,
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _tagger_fallback_mini_batch(
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    items: list[tuple[int, Post, Path]],
) -> None:
    """Retry tagger in mini-batches; only the failing one drops to per-image."""
    tagger = get_tagger()
    failed: list[tuple[int, str, str]] = []
    persisted: list[int] = []
    rating_updates: list[tuple[int, int]] = []
    tag_items: list[tuple[int, Any]] = []

    for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
        chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
        chunk_paths = [p for _, _, p in chunk]
        try:
            results = await asyncio.to_thread(tagger.tag, chunk_paths)
        except Exception as exc:
            logger.warning(
                f"[tagger] mini-batch failed ({exc!s}); falling back per-image",
            )
            await _tagger_per_image(
                tagger, posts, tag_groups, chunk, failed, persisted,
            )
            continue
        for (pid, post, _), resp in zip(chunk, results, strict=True):
            if not resp.general_tags and not resp.character_tags:
                failed.append((pid, "tagger", "no auto tags produced"))
                continue
            new_rating = from_rating_to_int(resp.rating)
            if post.rating == 0 and new_rating != 0:
                rating_updates.append((pid, new_rating))
            tag_items.append((pid, resp))
            persisted.append(pid)

    if rating_updates:
        await asyncio.to_thread(_update_ratings, posts, rating_updates)
    if tag_items:
        await attach_wdtagger_results_many(posts, tag_groups, tag_items, is_auto=True)
    if persisted:
        shadowed = await _find_posts_without_auto_tags(posts, persisted)
        failed.extend(
            (pid, "tagger", "all auto tags shadowed by manual tags") for pid in shadowed
        )
    if failed:
        await FailureRepo(posts.cur).record_failures(failed)


async def _tagger_per_image(  # noqa: PLR0913
    tagger: Any,
    posts: PostRepo,
    tag_groups: TagGroupRepo,
    items: list[tuple[int, Post, Path]],
    failed: list[tuple[int, str, str]],
    persisted: list[int],
) -> None:
    for pid, post, abs_path in items:
        try:
            resp = await asyncio.to_thread(tagger.tag, abs_path)
            if not resp.general_tags and not resp.character_tags:
                failed.append((pid, "tagger", "no auto tags produced"))
                continue
            new_rating = from_rating_to_int(resp.rating)
            if post.rating == 0 and new_rating != 0:
                await posts.update_field(pid, "rating", new_rating)
            await attach_wdtagger_results(posts, tag_groups, pid, resp, is_auto=True)
            persisted.append(pid)
        except (UnidentifiedImageError, OSError) as exc:
            logger.warning(f"[tagger] skipping unreadable image {pid} ({abs_path}): {exc}")
            failed.append((pid, "tagger", f"{type(exc).__name__}: {exc}"))
        except Exception as exc:
            logger.exception(f"[tagger] post {pid} ({abs_path})")
            failed.append((pid, "tagger", f"{type(exc).__name__}: {exc}"))


def _update_ratings(posts: PostRepo, updates: list[tuple[int, int]]) -> None:
    posts.cur.executemany(
        "UPDATE posts SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [(rating, pid) for pid, rating in updates],
    )


async def _score_batch_with_fallback(
    scorer_fn: Callable[[list[Path]], Any],
    items: list[tuple[int, Path]],
    *,
    worker_label: str,
) -> tuple[list[tuple[int, float]], list[tuple[int, str]]]:
    """Run ``scorer_fn`` on every item, shrinking the batch on failure.

    Tries the full batch first; on exception, retries in groups of
    ``FALLBACK_MINI_BATCH_SIZE`` so a single corrupt image doesn't drop the
    rest to single-image inference (which leaves the GPU ~80% idle between
    PIL decodes). Only the mini-batch that contains the bad image falls all
    the way to per-image retry.

    Returns ``(successes, failures)`` where ``successes`` is a list of
    ``(post_id, score)`` and ``failures`` is ``(post_id, error_message)``.
    """
    paths = [p for _, p in items]
    try:
        results = await asyncio.to_thread(scorer_fn, paths)
    except Exception as exc:
        logger.warning(
            f"[{worker_label}] full batch failed ({exc!s}); "
            f"retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
    else:
        return (
            [(pid, float(r)) for (pid, _), r in zip(items, results, strict=True)],
            [],
        )

    successes: list[tuple[int, float]] = []
    failures: list[tuple[int, str]] = []
    for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
        chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
        chunk_paths = [p for _, p in chunk]
        try:
            results = await asyncio.to_thread(scorer_fn, chunk_paths)
        except Exception as exc:
            logger.warning(
                f"[{worker_label}] mini-batch failed ({exc!s}); falling back per-image",
            )
            for pid, path in chunk:
                try:
                    single = await asyncio.to_thread(scorer_fn, [path])
                    successes.append((pid, float(single[0])))
                except (UnidentifiedImageError, OSError) as exc2:
                    logger.warning(f"[{worker_label}] unreadable {pid} ({path}): {exc2}")
                    failures.append((pid, f"{type(exc2).__name__}: {exc2}"))
                except Exception as exc2:
                    logger.exception(f"[{worker_label}] post {pid} ({path})")
                    failures.append((pid, f"{type(exc2).__name__}: {exc2}"))
        else:
            for (pid, _), r in zip(chunk, results, strict=True):
                successes.append((pid, float(r)))
    return successes, failures


async def _process_waifu_batch(posts: PostRepo, post_ids: list[int]) -> None:
    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer ML stack load

    scorer = get_waifu_scorer()
    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, abs_path))
    if not items:
        return

    successes, failures = await _score_batch_with_fallback(
        scorer, items, worker_label="waifu",
    )
    for pid, score in successes:
        await ScoreRepo(posts.cur).upsert_waifu_score(pid, score)
    if failures:
        await FailureRepo(posts.cur).record_failures([(pid, "waifu", err) for pid, err in failures])


async def _process_siglip_batch(posts: PostRepo, post_ids: list[int]) -> None:
    """Score a batch with SigLIP Aesthetic Predictor V2.5."""
    from ai.siglip_scorer import SCORER_NAME, score_images  # noqa: PLC0415  # lazy: defer ML stack load

    failure_worker = f"aesthetic:{SCORER_NAME}"
    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, abs_path))
    if not items:
        return

    successes, failures = await _score_batch_with_fallback(
        score_images, items, worker_label="siglip",
    )
    for pid, score in successes:
        await ScoreRepo(posts.cur).upsert_aesthetic_score(pid, SCORER_NAME, score)
    if failures:
        await FailureRepo(posts.cur).record_failures([(pid, failure_worker, err) for pid, err in failures])


async def _process_silva_batch(posts: PostRepo, vectors: VectorRepo, post_ids: list[int]) -> None:
    """Score a batch from stored SigLIP2 embeddings (no image decode / backbone).

    Posts without a stored embedding are silently skipped — they get scored on a
    later pass, once the embedding worker has filled them in. A head-forward
    failure is logged but not blacklisted: an embedding that exists should always
    be scoreable, so a failure is a transient/code problem worth retrying, not
    bad data to permanently skip.
    """
    from ai.silva_scorer import SCORER_NAME, score_embeddings  # noqa: PLC0415  # lazy: defer ML stack load

    emb_map = await vectors.get_many(post_ids)
    items = [(pid, emb_map[pid]) for pid in post_ids if pid in emb_map]
    if not items:
        return

    pids = [pid for pid, _ in items]
    embeddings = [emb for _, emb in items]
    try:
        scores = await asyncio.to_thread(score_embeddings, embeddings)
    except Exception:
        logger.exception(f"[silva] head forward failed for {len(pids)} posts starting at id {pids[0]}")
        return

    score_repo = ScoreRepo(posts.cur)
    for pid, score in zip(pids, scores, strict=True):
        await score_repo.upsert_aesthetic_score(pid, SCORER_NAME, float(score))


# ─── Basics compute / persist helpers ───────────────────────────────────


def _compute_basics_for(post: Post, file_abs_path: Path) -> dict | None:
    """Compute sha256 / arthash / dimensions / palette / dominant_color.

    Returns ``None`` when everything is already filled in (nothing to do).
    Raises on real I/O / decode failures so callers can decide what to do.
    """
    needs_sha256 = not post.sha256
    needs_arthash = not shared.disable_arthash and not post.arthash
    needs_color = post.dominant_color is None
    if not (needs_sha256 or needs_arthash or needs_color):
        return None

    with file_abs_path.open("rb") as f:
        file_data = f.read() if needs_sha256 else None
        f.seek(0)
        # Note: no img.verify() here — verify() ignores LOAD_TRUNCATED_IMAGES
        # and rejects partially-downloaded files even though decode below
        # handles them fine. Any genuine "not an image" file will still
        # fail at Image.open() and bubble up to the batch caller.
        with Image.open(f) as img:
            width, height = img.size

            relative = file_abs_path.relative_to(shared.target_dir)
            thumb_path = shared.thumbnails_dir / relative
            if not thumb_path.exists():
                thumb_path.parent.mkdir(parents=True, exist_ok=True)
                create_thumbnail_by_image(img, thumb_path)

            arthash = calculate_arthash(img) if needs_arthash else None
            if needs_color:
                colors_ints, dom_lab, color_err = _extract_colors(post.id, img)
            else:
                colors_ints, dom_lab, color_err = [], None, None

    return {
        "sha256": calculate_sha256(file_data) if (file_data and needs_sha256) else None,
        "size": file_abs_path.stat().st_size if needs_sha256 else None,
        "arthash": arthash,
        "width": width,
        "height": height,
        "colors": colors_ints,
        "dominant_lab": dom_lab,
        "color_error": color_err,
    }


def _persist_basics_batch(
    posts: PostRepo,
    valid: list[tuple[Post, Any, dict]],
) -> None:
    """Write a batch of compute results in one round of executemany calls."""
    if not valid:
        return
    cur = posts.cur

    # Single UPDATE template covers every row regardless of which fields it
    # actually computed: COALESCE keeps the existing column value when the
    # new value is None.
    main_rows = [
        (
            b["width"],
            b["height"],
            b["sha256"],
            b["sha256"],  # second placeholder controls whether `size` updates
            b["size"],
            b["arthash"],
            post.id,
        )
        for post, _, b in valid
    ]
    cur.executemany(
        """
        UPDATE posts SET
            width = ?,
            height = ?,
            sha256 = COALESCE(?, sha256),
            size = CASE WHEN ? IS NULL THEN size ELSE ? END,
            arthash = COALESCE(?, arthash),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        main_rows,
    )

    # dominant_color: store as sqlite-vec serialized FLOAT[3] BLOB. Restrict
    # to NULL → value so we don't overwrite already-computed colors.
    import sqlite_vec  # noqa: PLC0415

    dom_rows = [
        (sqlite_vec.serialize_float32(list(b["dominant_lab"])), post.id)
        for post, _, b in valid
        if b["dominant_lab"] is not None
    ]
    if dom_rows:
        cur.executemany(
            "UPDATE posts SET dominant_color = ? "
            "WHERE id = ? AND dominant_color IS NULL",
            dom_rows,
        )

    # post_has_color: replace the palette for every post that produced one.
    palette_post_ids = [post.id for post, _, b in valid if b["colors"]]
    if palette_post_ids:
        placeholders = ",".join("?" * len(palette_post_ids))
        cur.execute(
            f"DELETE FROM post_has_color WHERE post_id IN ({placeholders})",  # noqa: S608
            palette_post_ids,
        )
        color_rows = [
            (post.id, i, c)
            for post, _, b in valid
            for i, c in enumerate(b["colors"])
        ]
        cur.executemany(
            'INSERT INTO post_has_color(post_id, "order", color) VALUES (?, ?, ?)',
            color_rows,
        )


# ─── Color helpers ───────────────────────────────────────────────────────


def _rgb_to_lab(rgb_tuple: tuple[int, int, int]) -> np.ndarray:
    rgb_norm = np.array(rgb_tuple, dtype=np.float64) / 255.0
    return color.rgb2lab(rgb_norm.reshape(1, 1, 3)).reshape(3)


def _extract_colors(
    post_id: int,
    img: Image.Image,
) -> tuple[list[int], np.ndarray | None, str | None]:
    """Return (palette_ints, dominant_color_lab, error) from a decoded image.

    ColorThief's ``get_color`` is literally ``get_palette(...)[0]``, so the
    previous "call get_palette_ints then call get_dominant_color" sequence
    was doing the median-cut clustering twice. Compute the palette once,
    derive both outputs from it.

    The third tuple element is the colorthief error message when extraction
    failed (e.g. ``vbox1 not defined`` on degenerate single-colour images),
    or ``None`` on success. The caller uses this to permanently black-list
    the (post, basics) pair — without it, ``dominant_color IS NULL`` would
    re-select the post on every sync forever.
    """
    try:
        palette = get_palette(img)
    except Exception as exc:
        logger.warning(f"Color extraction failed for post {post_id}: {exc}")
        return [], None, str(exc)
    ints = [rgb2int(rgb) for rgb in palette]
    lab = _rgb_to_lab(palette[0]) if palette else None
    return ints, lab, None
