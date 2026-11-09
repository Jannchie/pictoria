"""The batch → mini-batch → per-image fallback ladder.

Lifted out of ``processors/common.py`` so the worker does not import the ``db``
package for it. That module pulls in ``FailureRepo`` at import time, and §D1
says this process opens no connection to ``pictoria.sqlite`` at all — an import
that *could* write is the first crack in a rule whose whole value is that it has
no exceptions. ``processors/`` goes away in Phase 7; this is where the ladder
lives now, not a second copy of it.

The other half of the move is that failures come back as **data** instead of
being written here. The caller (TS) decides what a failure means — blacklist,
retry, ignore — because the caller is the one that owns the database.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import TYPE_CHECKING, TypeVar

from PIL import UnidentifiedImageError

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from pathlib import Path

log = logging.getLogger("worker.ladder")

#: Result a worker's batch function produces (a score, an embedding, a tagger
#: response, ...) — the ladder is generic over it.
R = TypeVar("R")

#: When the full GPU batch crashes (typically one unreadable image in the
#: collate), shrink to this before going single-image. Mid-size batches keep the
#: GPU usefully fed — a batch of 4 amortizes most of the launch/collate overhead
#: — while bounding the blast radius of one bad image to 4 retries.
FALLBACK_MINI_BATCH_SIZE = 4

Outcome = tuple[list[tuple[int, R]], list[tuple[int, str]]]
"""``(successes, failures)`` — ``(post_id, result)`` and ``(post_id, message)``."""


def _classify(
    chunk: Sequence[tuple[int, Path]],
    results: Sequence[R],
    reject_reason: Callable[[int, R], str | None] | None,
) -> Outcome:
    """Split one chunk's results into successes and rejections.

    A produced result is a success unless ``reject_reason`` returns a message
    for it (the tagger rejecting an empty response, say).
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


def _free_after_oom(exc: BaseException) -> bool:
    """If ``exc`` is torch's CUDA OOM, hand cached blocks back and return True.

    Freeing gives the next, smaller rung room to run. ``torch`` is looked up
    through ``sys.modules`` so this module never imports it: if torch is not
    loaded, nothing could have raised its OOM.
    """
    torch = sys.modules.get("torch")
    if torch is None or not isinstance(exc, torch.cuda.OutOfMemoryError):
        return False
    torch.cuda.empty_cache()
    return True


class SystemicBatchError(RuntimeError):
    """A failure that belongs to the process, not to any one image.

    The ladder's rungs encode *how small a group must be to isolate the bad
    image*. A CUDA OOM on a **single** fixed-size input (every model here
    resizes or pads to a fixed resolution, so one image is never bigger than
    another on the GPU) cannot be that image's fault — the card is full or the
    context is poisoned. Returning it as a per-image failure would let TS
    blacklist the post forever, and every post after it in the backlog, so it
    is raised instead: the task fails, the backfill loop backs off and retries
    the same posts later.
    """


async def _retry_per_image(
    batch_fn: Callable[[list[Path]], Sequence[R]],
    chunk: Sequence[tuple[int, Path]],
    *,
    label: str,
    reject_reason: Callable[[int, R], str | None] | None,
) -> Outcome:
    """Last-resort per-image retry for a mini-batch that failed as a group."""
    successes: list[tuple[int, R]] = []
    failures: list[tuple[int, str]] = []
    for pid, path in chunk:
        try:
            single = await asyncio.to_thread(batch_fn, [path])
        except (UnidentifiedImageError, OSError) as exc:
            log.warning("[%s] unreadable %s (%s): %s", label, pid, path, exc)
            failures.append((pid, f"{type(exc).__name__}: {exc}"))
        except Exception as exc:
            if _free_after_oom(exc):
                msg = f"[{label}] CUDA out of memory on a single image (post {pid}); not this image's fault"
                raise SystemicBatchError(msg) from exc
            log.exception("[%s] post %s (%s)", label, pid, path)
            failures.append((pid, f"{type(exc).__name__}: {exc}"))
        else:
            reason = reject_reason(pid, single[0]) if reject_reason is not None else None
            if reason is None:
                successes.append((pid, single[0]))
            else:
                failures.append((pid, reason))
    return successes, failures


async def run_with_fallback(
    batch_fn: Callable[[list[Path]], Sequence[R]],
    items: Sequence[tuple[int, Path]],
    *,
    label: str,
    prepare: Callable[[], object],
    reject_reason: Callable[[int, R], str | None] | None = None,
) -> Outcome:
    """Run ``batch_fn`` over ``items``, shrinking the batch on failure.

    ``prepare`` loads whatever ``batch_fn`` needs (weights, processor) and runs
    off-loop **before** the first rung, outside every ``except``. Required, not
    optional: a load failing inside the ladder looks exactly like every image
    in the batch being bad, and TS blacklists those for good. Raised here, it
    fails the task instead, and the backfill loop retries it later.

    Full batch first; on exception, retry in groups of
    :data:`FALLBACK_MINI_BATCH_SIZE` so one corrupt image does not drop the rest
    to single-image inference (which leaves the GPU ~80% idle between PIL
    decodes). Only the mini-batch holding the bad image falls all the way down.

    Persists nothing. ``failures`` is returned for the caller to write, so a
    persistence error can't masquerade as a bad image.
    """
    if not items:
        return [], []

    await asyncio.to_thread(prepare)
    paths = [p for _, p in items]
    try:
        results = await asyncio.to_thread(batch_fn, paths)
    except Exception as exc:
        _free_after_oom(exc)
        log.warning(
            "[%s] full batch failed (%s); retrying in mini-batches of %d",
            label, exc, FALLBACK_MINI_BATCH_SIZE,
        )
    else:
        return _classify(items, results, reject_reason)

    successes: list[tuple[int, R]] = []
    failures: list[tuple[int, str]] = []
    for start in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
        chunk = items[start : start + FALLBACK_MINI_BATCH_SIZE]
        try:
            results = await asyncio.to_thread(batch_fn, [p for _, p in chunk])
        except Exception as exc:
            _free_after_oom(exc)
            succ, fail = await _retry_per_image(
                batch_fn, chunk, label=label, reject_reason=reject_reason,
            )
        else:
            succ, fail = _classify(chunk, results, reject_reason)
        successes += succ
        failures += fail
    return successes, failures
