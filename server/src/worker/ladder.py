"""Decode, then forward: the per-image failure policy and the OOM ladder.

Lifted out of ``processors/common.py`` so the worker does not import the ``db``
package for it. That module pulls in ``FailureRepo`` at import time, and §D1
says this process opens no connection to ``pictoria.sqlite`` at all — an import
that *could* write is the first crack in a rule whose whole value is that it has
no exceptions.

Failures come back as **data** instead of being written here. The caller (TS)
decides what a failure means, because the caller owns the database — and for
the image workers it means a **permanent** blacklist (``post_process_failures``).
That is what every rule below is shaped by: a failure returned from here costs
the post its result forever, so only a failure that is provably the *image's*
goes back as one.

The batch is split in two phases:

* **decode** — open + preprocess, one image at a time on a thread pool, with
  each image's exception collected by index. A file PIL cannot read fails here,
  once, and the rest of the batch never sees it. This used to be one function
  that decoded *and* forwarded, so one bad file made the ladder re-decode the
  whole batch two or three times (full batch → mini-batches → singles) just to
  find it.
* **forward** — the GPU part, over tensors that already decoded. Every model
  here resizes or pads to a fixed resolution, so no tensor is bigger than
  another and the only thing a smaller group fixes is a CUDA OOM. The
  batch → :data:`FALLBACK_MINI_BATCH_SIZE` → single ladder is kept for exactly
  that.

Each exception is sorted into one of three bins (:func:`classify`):

* ``image`` — a decode error (unidentified / truncated / corrupt file, a
  decompression bomb, a file that is gone). Per-image failure; TS blacklists it.
* ``systemic`` — the process, not the image: CUDA errors, ``MemoryError``,
  ``PermissionError``. Raised as :class:`SystemicBatchError`; the task fails,
  nothing is blacklisted, and the backfill loop backs off and retries.
* ``other`` — anything else (a processor ``ValueError`` on an odd image mode, a
  bug). Per-image failure, *but* counted: when a batch's failures say the code is
  broken rather than the images (:func:`_tripped`), the whole task fails instead.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import sys
from typing import TYPE_CHECKING, Literal, TypeVar

from PIL import Image, UnidentifiedImageError

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from pathlib import Path

log = logging.getLogger("worker.ladder")

#: What one image decodes to (a preprocessed tensor) — the ladder is generic over it.
T = TypeVar("T")
#: Result a worker's forward produces per image (a score, an embedding, a tagger
#: response, ...).
R = TypeVar("R")

#: When the full GPU batch runs out of memory, shrink to this before going
#: single-image. Mid-size batches keep the GPU usefully fed — a batch of 4
#: amortizes most of the launch overhead.
FALLBACK_MINI_BATCH_SIZE = 4

#: Circuit breaker, the absolute arm: this many ``other`` failures in one batch
#: is not a run of unlucky files, it is the code. Checked in :meth:`_Tally.failed`;
#: the proportional arm is :func:`_tripped`.
BREAKER_MIN_FAILURES = 8

Outcome = tuple[list[tuple[int, R]], list[tuple[int, str]]]
"""``(successes, failures)`` — ``(post_id, result)`` and ``(post_id, message)``."""

Kind = Literal["image", "systemic", "other"]

#: Exceptions that are the file's fault. ``OSError`` covers truncated reads and
#: a vanished file (``FileNotFoundError``); its ``PermissionError`` subclass is
#: carved out in :func:`classify` — a permission is the process's problem, and
#: fixing it must not find the post already blacklisted. ``SyntaxError`` /
#: ``EOFError`` / ``struct.error`` are what PIL's plugins raise on a malformed
#: header or chunk.
IMAGE_ERRORS: tuple[type[BaseException], ...] = (
    UnidentifiedImageError,
    Image.DecompressionBombError,
    OSError,
    SyntaxError,
    EOFError,
    struct.error,
)


class SystemicBatchError(RuntimeError):
    """A failure that belongs to the process, not to any one image.

    Raised instead of returned: the task fails, the backfill loop
    (``apps/api/src/scheduler.ts``) logs it, backs off and offers the same
    posts again later. Returning it as per-image failures would let TS
    blacklist every post in the batch forever — and, the pending query being
    id-ordered, every post after them too, one batch at a time.
    """


def _is_cuda_oom(exc: BaseException) -> bool:
    torch = sys.modules.get("torch")
    return torch is not None and isinstance(exc, torch.cuda.OutOfMemoryError)


def classify(exc: BaseException) -> Kind:
    """Which bin ``exc`` belongs in — see the module docstring.

    ``torch`` is looked up through ``sys.modules`` so this module never imports
    it: if torch is not loaded, nothing could have raised one of its errors.
    """
    torch = sys.modules.get("torch")
    accelerator_error = getattr(torch, "AcceleratorError", None) if torch is not None else None
    if isinstance(exc, MemoryError | PermissionError):
        return "systemic"
    if accelerator_error is not None and isinstance(exc, accelerator_error):
        return "systemic"
    # OutOfMemoryError is a RuntimeError whose message says CUDA, so this arm
    # covers it too — callers that want the OOM *ladder* check it first.
    if isinstance(exc, RuntimeError) and "CUDA" in str(exc):
        return "systemic"
    if isinstance(exc, IMAGE_ERRORS):
        return "image"
    return "other"


def _free_after_oom(exc: BaseException) -> bool:
    """If ``exc`` is torch's CUDA OOM, hand cached blocks back and return True.

    Freeing gives the next, smaller rung room to run.
    """
    if not _is_cuda_oom(exc):
        return False
    sys.modules["torch"].cuda.empty_cache()
    return True


def _message(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


class _Tally:
    """One batch's bookkeeping, shared by both phases."""

    def __init__(self, label: str, total: int) -> None:
        self.label = label
        #: Items in the batch — the breaker's denominator, quoted when it trips.
        self.total = total
        self.successes: list[tuple[int, object]] = []
        self.failures: list[tuple[int, str]] = []
        #: Items whose failure was ``other`` — what the breaker counts.
        self.other = 0
        #: Items that failed with a decode error — the breaker's denominator
        #: leaves them out: they already have an explanation.
        self.image = 0
        #: The first ``other`` message, quoted when the breaker trips.
        self.first_other: str | None = None

    def failed(self, pid: int, path: Path | None, exc: BaseException) -> None:
        """Record one image's exception as per-image, or raise if it is systemic."""
        kind = classify(exc)
        if kind == "systemic":
            msg = f"[{self.label}] systemic error on post {pid}: {_message(exc)}"
            raise SystemicBatchError(msg) from exc
        if kind == "image":
            self.image += 1
            log.warning("[%s] unreadable %s (%s): %s", self.label, pid, path, exc)
        else:
            self.other += 1
            self.first_other = self.first_other or _message(exc)
            log.error("[%s] post %s (%s) failed: %s", self.label, pid, path, _message(exc), exc_info=exc)
            if self.other >= BREAKER_MIN_FAILURES:
                # The absolute arm cannot un-trip, so the rest of the per-image
                # retries would be spent only to raise this at the end.
                raise SystemicBatchError(self.breaker_message())
        self.failures.append((pid, _message(exc)))

    def breaker_message(self) -> str:
        return (
            f"[{self.label}] circuit breaker: {self.other} of {self.total} images failed for "
            f"reasons that are not decode errors; failing the task instead of blacklisting them "
            f"(first: {self.first_other})"
        )


def _tripped(tally: _Tally) -> bool:
    """Whether the batch's ``other`` failures say *the code* is broken.

    The proportional arm: every item that did not already fail on a decode
    error failed for an unexplained reason (a processor that rejects everything,
    a forward that always raises) — 100%, however small the batch.

    The absolute arm (:data:`BREAKER_MIN_FAILURES`) is not checked here: it trips
    in :meth:`_Tally.failed` the moment the count is reached, so a broken forward
    does not run out the rest of the batch one image at a time first — and by the
    time this runs, ``other`` is necessarily below it.
    """
    return 0 < tally.other >= tally.total - tally.image


async def _forward(
    forward: Callable[[list[T]], Sequence[R]],
    group: Sequence[tuple[int, Path, T]],
    tally: _Tally,
    reject_reason: Callable[[int, R], str | None] | None,
) -> None:
    """Forward ``group``; on OOM shrink it, on any other error isolate per image."""
    try:
        results = await asyncio.to_thread(forward, [t for _, _, t in group])
    except Exception as exc:
        oom = _free_after_oom(exc)
        if not oom and classify(exc) == "systemic":
            msg = f"[{tally.label}] systemic error in the forward: {_message(exc)}"
            raise SystemicBatchError(msg) from exc
        if len(group) == 1:
            pid, path, _ = group[0]
            if oom:
                # Fixed-size input: one image cannot be bigger than another on
                # the GPU, so an OOM at a batch of one is the card, not the post.
                msg = f"[{tally.label}] CUDA out of memory on a single image (post {pid}); not this image's fault"
                raise SystemicBatchError(msg) from exc
            tally.failed(pid, path, exc)
            return
        # OOM: the next rung. Anything else is not a size problem, so a smaller
        # group buys nothing; go straight to one at a time to find the image.
        size = FALLBACK_MINI_BATCH_SIZE if oom and len(group) > FALLBACK_MINI_BATCH_SIZE else 1
        log.warning("[%s] forward of %d failed (%s); retrying in groups of %d", tally.label, len(group), exc, size)
        for start in range(0, len(group), size):
            await _forward(forward, group[start : start + size], tally, reject_reason)
        return
    for (pid, _, _), result in zip(group, results, strict=True):
        reason = reject_reason(pid, result) if reject_reason is not None else None
        if reason is None:
            tally.successes.append((pid, result))
        else:
            tally.failures.append((pid, reason))


async def run_with_fallback(  # noqa: PLR0913 — two phases + the ladder's three knobs
    decode: Callable[[list[Path]], Sequence[T | BaseException]],
    forward: Callable[[list[T]], Sequence[R]],
    items: Sequence[tuple[int, Path]],
    *,
    label: str,
    prepare: Callable[[], object],
    reject_reason: Callable[[int, R], str | None] | None = None,
) -> Outcome:
    """Decode ``items``, forward what decoded, and sort out the failures.

    ``decode`` takes the batch's paths and returns one entry per path, in order:
    the decoded value or the exception that image raised. It must not raise for
    a single image — collecting by index is what keeps a bad file from costing
    the rest of the batch a second decode.

    ``prepare`` loads whatever the two phases need (weights, processor) and runs
    off-loop **before** anything else, outside every ``except``. Required, not
    optional: a load failing inside the ladder would look exactly like every
    image in the batch being bad. Raised here, it fails the task instead.

    Persists nothing. ``failures`` is returned for the caller to write, so a
    persistence error can't masquerade as a bad image.

    Raises :class:`SystemicBatchError` for a systemic error anywhere, or when the
    circuit breaker trips (:func:`_tripped`).
    """
    if not items:
        return [], []

    await asyncio.to_thread(prepare)
    decoded = await asyncio.to_thread(decode, [p for _, p in items])
    if len(decoded) != len(items):
        msg = f"[{label}] decode returned {len(decoded)} entries for {len(items)} paths"
        raise SystemicBatchError(msg)

    tally = _Tally(label, len(items))
    ready: list[tuple[int, Path, T]] = []
    for (pid, path), value in zip(items, decoded, strict=True):
        if isinstance(value, BaseException):
            tally.failed(pid, path, value)
        else:
            ready.append((pid, path, value))

    if ready:
        await _forward(forward, ready, tally, reject_reason)

    if _tripped(tally):
        raise SystemicBatchError(tally.breaker_message())
    return tally.successes, tally.failures  # type: ignore[return-value]
