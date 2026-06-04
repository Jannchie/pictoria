"""Quality-score workers: waifu (image-based) and SILVA (embedding-based)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from PIL import UnidentifiedImageError

from db.repositories.failures import FailureRepo
from db.repositories.scores import ScoreRepo
from processors.common import FALLBACK_MINI_BATCH_SIZE, IMAGE_EXT_WHERE, IMAGE_EXTS, drive
from shared import logger

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from rich.progress import Progress

    from db.repositories.posts import PostRepo
    from db.repositories.vectors import VectorRepo

WAIFU_BATCH_SIZE = 32
# SILVA scores stored embeddings (no image decode / backbone) — a pure head
# forward, so batches can be large and cheap.
SILVA_BATCH_SIZE = 256


async def run_waifu_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the waifu quality score into ``post_waifu_scores``."""
    pending = await _list_waifu_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_waifu_batch(posts, batch_ids)

    await drive(
        progress,
        "Waifu scorer",
        pending,
        WAIFU_BATCH_SIZE,
        _process,
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

    await drive(progress, "SILVA scorer", pending, SILVA_BATCH_SIZE, _process)


# ─── Pending queries ────────────────────────────────────────────────────


async def _list_waifu_pending(posts: PostRepo) -> list[int]:
    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id
            WHERE pws.post_id IS NULL
              AND {IMAGE_EXT_WHERE}
              AND NOT EXISTS (
                SELECT 1 FROM post_process_failures f
                WHERE f.post_id = p.id AND f.worker = 'waifu'
              )
            ORDER BY p.id
            """,  # noqa: S608
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_silva_pending(posts: PostRepo, scorer: str) -> list[int]:
    """Posts that have a SigLIP2 embedding but no ``scorer`` aesthetic score.

    SILVA scores the *embedding*, not the
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


# ─── Batch processors ───────────────────────────────────────────────────


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
            f"[{worker_label}] full batch failed ({exc!s}); retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
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
        scorer,
        items,
        worker_label="waifu",
    )
    for pid, score in successes:
        await ScoreRepo(posts.cur).upsert_waifu_score(pid, score)
    if failures:
        await FailureRepo(posts.cur).record_failures([(pid, "waifu", err) for pid, err in failures])


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
