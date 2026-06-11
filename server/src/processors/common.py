"""Shared constants, helpers, and the batch driver used by every backfill worker."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, TypeVar

from PIL import UnidentifiedImageError

import shared
from shared import logger

if TYPE_CHECKING:
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


async def run_batch_with_fallback(
    batch_fn: Callable[[list[Path]], Sequence[R]],
    items: Sequence[tuple[int, Path]],
    *,
    worker_label: str,
) -> tuple[list[tuple[int, R]], list[tuple[int, str]]]:
    """Run ``batch_fn`` on every item, shrinking the batch on failure.

    Tries the full batch first; on exception, retries in groups of
    ``FALLBACK_MINI_BATCH_SIZE`` so a single corrupt image doesn't drop the
    rest to single-image inference (which leaves the GPU ~80% idle between
    PIL decodes). Only the mini-batch that contains the bad image falls all
    the way to per-image retry.

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
        return list(zip((pid for pid, _ in items), results, strict=True)), []

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
            for pid, path in chunk:
                try:
                    single = await asyncio.to_thread(batch_fn, [path])
                    successes.append((pid, single[0]))
                except (UnidentifiedImageError, OSError) as exc2:
                    logger.warning(f"[{worker_label}] unreadable {pid} ({path}): {exc2}")
                    failures.append((pid, f"{type(exc2).__name__}: {exc2}"))
                except Exception as exc2:
                    logger.exception(f"[{worker_label}] post {pid} ({path})")
                    failures.append((pid, f"{type(exc2).__name__}: {exc2}"))
        else:
            successes.extend(zip((pid for pid, _ in chunk), results, strict=True))
    return successes, failures
