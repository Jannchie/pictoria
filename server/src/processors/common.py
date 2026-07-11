"""Shared constants, helpers, and the batch driver used by every backfill worker."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, TypeVar

from PIL import UnidentifiedImageError

import shared
from db.repositories.failures import FailureRepo
from shared import logger

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Awaitable, Callable, Sequence
    from pathlib import Path

    from rich.progress import Progress

    from db.entities import Post

# Result type produced by a worker's batch function (a score, an embedding,
# a tagger response, ...) — ``run_batch_with_fallback`` is generic over it.
R = TypeVar("R")


IMAGE_EXTS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"},
)

# Same extensions but without the leading dot, formatted for inlining into a
# SQL ``IN (...)`` clause. Used by every pending-query so the workers never
# enqueue ``.txt`` / ``.zip`` / etc. — those would just be filtered out
# image-by-image inside the batch processor anyway, while still ticking the
# progress bar.
_IMAGE_EXT_SQL_LIST = ", ".join(f"'{ext.lstrip('.')}'" for ext in sorted(IMAGE_EXTS))
IMAGE_EXT_WHERE = f"LOWER(p.extension) IN ({_IMAGE_EXT_SQL_LIST})"

# When the full GPU batch crashes (typically one unreadable image in the
# collate), we shrink to this size before going single-image. Mid-size
# batches keep the GPU usefully fed (a batch of 4 amortizes most of the
# launch / collate overhead) while bounding the blast radius of a single
# bad image to 4 retries.
FALLBACK_MINI_BATCH_SIZE = 4


async def drive(  # noqa: PLR0913
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
        effective_size = adaptive_batch_size(batch_size, label=name) if gpu_adaptive else batch_size
        batch = pending[i : i + effective_size]
        try:
            await process(batch)
        except Exception:
            logger.exception(f"[{name}] batch starting at id {batch[0]} failed")
        if progress is not None and task is not None:
            progress.update(task, advance=len(batch))
        i += len(batch)


def build_image_items(
    posts_map: dict[int, Post],
    post_ids: Sequence[int],
) -> list[tuple[int, Post, Path]]:
    """Resolve ``post_ids`` into ``(post_id, post, absolute_path)`` image triples.

    The shared preamble of every batch processor: drop ids whose row vanished
    between the pending query and the batch, drop non-image extensions, and
    drop files that have disappeared from disk. Output order follows
    ``post_ids``.
    """
    items: list[tuple[int, Post, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, post, abs_path))
    return items


def _classify_results(
    chunk: Sequence[tuple[int, Path]],
    results: Sequence[R],
    reject_reason: Callable[[int, R], str | None] | None,
) -> tuple[list[tuple[int, R]], list[tuple[int, str]]]:
    """Split ``batch_fn``'s results into successes / rejections for one chunk.

    A produced result is a success unless ``reject_reason`` returns a message
    for it (e.g. the tagger rejecting an empty response); with no
    ``reject_reason`` every result is a success.
    """
    succ: list[tuple[int, R]] = []
    fail: list[tuple[int, str]] = []
    for (pid, _), result in zip(chunk, results, strict=True):
        reason = reject_reason(pid, result) if reject_reason is not None else None
        if reason is None:
            succ.append((pid, result))
        else:
            fail.append((pid, reason))
    return succ, fail


async def _retry_per_image(
    batch_fn: Callable[[list[Path]], Sequence[R]],
    chunk: Sequence[tuple[int, Path]],
    *,
    worker_label: str,
    reject_reason: Callable[[int, R], str | None] | None,
) -> tuple[list[tuple[int, R]], list[tuple[int, str]]]:
    """Last-resort per-image retry for a mini-batch that failed as a group.

    An unreadable image (``UnidentifiedImageError`` / ``OSError``) or any other
    per-image error becomes a ``(post_id, message)`` failure; a produced result
    is still subject to ``reject_reason``.
    """
    successes: list[tuple[int, R]] = []
    failures: list[tuple[int, str]] = []
    for pid, path in chunk:
        try:
            single = await asyncio.to_thread(batch_fn, [path])
        except (UnidentifiedImageError, OSError) as exc:
            logger.warning(f"[{worker_label}] unreadable {pid} ({path}): {exc}")
            failures.append((pid, f"{type(exc).__name__}: {exc}"))
        except Exception as exc:
            logger.exception(f"[{worker_label}] post {pid} ({path})")
            failures.append((pid, f"{type(exc).__name__}: {exc}"))
        else:
            reason = reject_reason(pid, single[0]) if reject_reason is not None else None
            if reason is None:
                successes.append((pid, single[0]))
            else:
                failures.append((pid, reason))
    return successes, failures


async def run_batch_with_fallback(
    batch_fn: Callable[[list[Path]], Sequence[R]],
    items: Sequence[tuple[int, Path]],
    *,
    worker_label: str,
    reject_reason: Callable[[int, R], str | None] | None = None,
) -> tuple[list[tuple[int, R]], list[tuple[int, str]]]:
    """Run ``batch_fn`` on every item, shrinking the batch on failure.

    Tries the full batch first; on exception, retries in groups of
    ``FALLBACK_MINI_BATCH_SIZE`` so a single corrupt image doesn't drop the
    rest to single-image inference (which leaves the GPU ~80% idle between
    PIL decodes). Only the mini-batch that contains the bad image falls all
    the way to per-image retry.

    ``reject_reason`` is an optional post-inference validator: called with
    ``(post_id, result)`` for every result the model *did* produce, it returns
    a failure message to reclassify that result as a failure (e.g. the tagger
    rejecting an empty tag response), or ``None`` to keep it a success. It runs
    at every degradation level, so an empty result is blacklisted the same way
    whether it came back in the full batch or a per-image retry. Left ``None``
    (waifu / embedding), every produced result is a success.

    Returns ``(successes, failures)`` where ``successes`` is a list of
    ``(post_id, result)`` and ``failures`` is ``(post_id, error_message)``.
    Does NO persistence — the caller writes ``successes`` through its repo's
    batch upsert and ``failures`` through ``FailureRepo.record_failures``, so
    a persistence error propagates instead of masquerading as a bad image.
    """
    paths = [p for _, p in items]
    try:
        results = await asyncio.to_thread(batch_fn, paths)
    except Exception as exc:
        logger.warning(
            f"[{worker_label}] full batch failed ({exc!s}); retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
    else:
        return _classify_results(items, results, reject_reason)

    successes: list[tuple[int, R]] = []
    failures: list[tuple[int, str]] = []
    for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
        chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
        chunk_paths = [p for _, p in chunk]
        try:
            results = await asyncio.to_thread(batch_fn, chunk_paths)
        except Exception as exc:
            logger.warning(
                f"[{worker_label}] mini-batch failed ({exc!s}); falling back per-image",
            )
            succ, fail = await _retry_per_image(
                batch_fn,
                chunk,
                worker_label=worker_label,
                reject_reason=reject_reason,
            )
        else:
            succ, fail = _classify_results(chunk, results, reject_reason)
        successes.extend(succ)
        failures.extend(fail)
    return successes, failures


async def record_pair_failures(
    cur: sqlite3.Cursor,
    worker: str,
    failures: Sequence[tuple[int, str]],
) -> None:
    """Blacklist ``(post_id, error_message)`` pairs under one worker bucket.

    The shared write side of the ladder: every worker that produces
    ``(post_id, error)`` pairs records them the same way, so the
    ``FailureRepo`` round-trip lives in one place instead of a copy per
    worker. No-op on an empty list.
    """
    if not failures:
        return
    await FailureRepo(cur).record_failures([(pid, worker, err) for pid, err in failures])
