"""Shared constants and the batch driver used by every backfill worker."""

from __future__ import annotations

from typing import TYPE_CHECKING

import shared
from shared import logger

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from rich.progress import Progress


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
