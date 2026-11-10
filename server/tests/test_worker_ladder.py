"""Decode, then forward: which failures belong to an image, and the OOM ladder."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import torch
from PIL import Image, UnidentifiedImageError

from worker.ladder import BREAKER_MIN_FAILURES, SystemicBatchError, classify, run_with_fallback

ITEMS = [(i, Path(f"img{i}.png")) for i in range(10)]
BAD = Path("img3.png")


def _decode_ok(paths: list[Path]) -> list[object]:
    return [p.name for p in paths]


def _forward_ok(names: list[str]) -> list[str]:
    return list(names)


def _run(decode=_decode_ok, forward=_forward_ok, items=ITEMS, **kwargs):
    return asyncio.run(run_with_fallback(decode, forward, items, label="test", prepare=lambda: None, **kwargs))


# ─── classification ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "exc",
    [
        UnidentifiedImageError("cannot identify image file"),
        Image.DecompressionBombError("too big"),
        OSError("image file is truncated"),
        FileNotFoundError("gone"),
        SyntaxError("broken PNG file"),
    ],
)
def test_decode_errors_are_the_image(exc: BaseException) -> None:
    assert classify(exc) == "image"


@pytest.mark.parametrize(
    "exc",
    [
        PermissionError("access denied"),
        MemoryError(),
        RuntimeError("CUDA error: an illegal memory access was encountered"),
        torch.cuda.OutOfMemoryError("CUDA out of memory"),
        torch.AcceleratorError("device-side assert triggered"),
    ],
)
def test_process_errors_are_systemic(exc: BaseException) -> None:
    assert classify(exc) == "systemic"


@pytest.mark.parametrize("exc", [ValueError("unsupported mode"), RuntimeError("shape mismatch"), IndexError()])
def test_everything_else_is_other(exc: BaseException) -> None:
    assert classify(exc) == "other"


# ─── decode phase ───────────────────────────────────────────────────────────


def test_one_unreadable_image_fails_alone_and_is_decoded_once() -> None:
    decoded: list[Path] = []
    forwarded: list[list[str]] = []

    def decode(paths: list[Path]) -> list[object]:
        decoded.extend(paths)
        return [UnidentifiedImageError("cannot identify image file") if p == BAD else p.name for p in paths]

    def forward(names: list[str]) -> list[str]:
        forwarded.append(names)
        return names

    successes, failures = _run(decode, forward)
    assert [pid for pid, _ in successes] == [i for i in range(10) if i != 3]
    assert [pid for pid, _ in failures] == [3]
    assert failures[0][1].startswith("UnidentifiedImageError")
    # No re-decode to find the bad file, and one forward over the rest.
    assert decoded == [p for _, p in ITEMS]
    assert forwarded == [[f"img{i}.png" for i in range(10) if i != 3]]


def test_every_image_unreadable_is_still_per_image() -> None:
    """Decode errors are explained; they never trip the breaker."""
    successes, failures = _run(lambda paths: [OSError("truncated") for _ in paths])
    assert successes == []
    assert len(failures) == 10


@pytest.mark.parametrize("exc", [PermissionError("denied"), MemoryError(), torch.AcceleratorError("CUDA error: misaligned address")])
def test_a_systemic_decode_error_fails_the_task(exc: BaseException) -> None:
    with pytest.raises(SystemicBatchError):
        _run(lambda paths: [exc if p == BAD else p.name for p in paths])


# ─── forward phase ──────────────────────────────────────────────────────────


def test_oom_that_fits_in_a_smaller_batch_is_not_a_failure() -> None:
    sizes: list[int] = []

    def forward(names: list[str]) -> list[str]:
        sizes.append(len(names))
        if len(names) > 4:
            msg = "CUDA out of memory"
            raise torch.cuda.OutOfMemoryError(msg)
        return names

    successes, failures = _run(forward=forward)
    assert len(successes) == 10
    assert failures == []
    assert sizes == [10, 4, 4, 2]


def test_oom_on_a_single_image_fails_the_task_instead_of_blacklisting() -> None:
    """Every input is fixed-size on the GPU, so one image can't be the cause."""

    def forward(_names: list[str]) -> list[str]:
        msg = "CUDA out of memory"
        raise torch.cuda.OutOfMemoryError(msg)

    with pytest.raises(SystemicBatchError, match="single image"):
        _run(forward=forward)


def test_a_cuda_error_in_the_forward_fails_the_task() -> None:
    def forward(_names: list[str]) -> list[str]:
        msg = "CUDA error: an illegal memory access was encountered"
        raise RuntimeError(msg)

    with pytest.raises(SystemicBatchError):
        _run(forward=forward)


def test_one_image_the_forward_rejects_is_isolated_per_image() -> None:
    def forward(names: list[str]) -> list[str]:
        if BAD.name in names:
            msg = "shape mismatch"
            raise RuntimeError(msg)
        return names

    successes, failures = _run(forward=forward)
    assert failures == [(3, "RuntimeError: shape mismatch")]
    assert len(successes) == 9


# ─── circuit breaker ────────────────────────────────────────────────────────


def test_breaker_every_image_failing_for_an_unexplained_reason_fails_the_task() -> None:
    def forward(_names: list[str]) -> list[str]:
        msg = "processor bug"
        raise ValueError(msg)

    with pytest.raises(SystemicBatchError, match="circuit breaker"):
        _run(forward=forward)


def test_breaker_counts_only_what_decode_did_not_explain() -> None:
    """3 truncated files + 7 unexplained failures = 100% of the explainable rest."""

    def decode(paths: list[Path]) -> list[object]:
        return [OSError("truncated") if int(p.stem[3:]) < 3 else ValueError("bad mode") for p in paths]

    with pytest.raises(SystemicBatchError, match="7 of 10"):
        _run(decode)


def test_breaker_absolute_arm() -> None:
    items = [(i, Path(f"img{i}.png")) for i in range(32)]

    def decode(paths: list[Path]) -> list[object]:
        return [ValueError("bad mode") if int(p.stem[3:]) < BREAKER_MIN_FAILURES else p.name for p in paths]

    with pytest.raises(SystemicBatchError, match="circuit breaker"):
        _run(decode, items=items)


def test_breaker_absolute_arm_stops_at_the_nth_single_image_failure() -> None:
    """A forward that always raises is split into singles; the breaker must trip
    on the BREAKER_MIN_FAILURES-th of them, not after running the whole batch."""
    items = [(i, Path(f"img{i}.png")) for i in range(32)]
    calls: list[int] = []

    def forward(names: list[str]) -> list[str]:
        calls.append(len(names))
        msg = "processor bug"
        raise ValueError(msg)

    with pytest.raises(SystemicBatchError, match=f"circuit breaker: {BREAKER_MIN_FAILURES} of 32"):
        _run(forward=forward, items=items)
    # One full-batch attempt, then exactly N singles.
    assert calls == [32] + [1] * BREAKER_MIN_FAILURES


def test_breaker_a_few_odd_images_stay_per_image() -> None:
    def decode(paths: list[Path]) -> list[object]:
        return [ValueError("bad mode") if p == BAD else p.name for p in paths]

    successes, failures = _run(decode)
    assert len(successes) == 9
    assert failures == [(3, "ValueError: bad mode")]


def test_reject_reason_applies_after_the_forward() -> None:
    successes, failures = _run(reject_reason=lambda pid, _r: "empty" if pid == 5 else None)
    assert [pid for pid, _ in failures] == [5]
    assert len(successes) == 9


# ─── prepare ────────────────────────────────────────────────────────────────


def test_a_failed_load_fails_the_task_not_the_images() -> None:
    def load() -> None:
        msg = "model download failed"
        raise OSError(msg)

    with pytest.raises(OSError, match="download"):
        asyncio.run(run_with_fallback(_decode_ok, _forward_ok, ITEMS, label="test", prepare=load))
