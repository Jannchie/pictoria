"""The batch → mini-batch → per-image ladder: which failures belong to an image."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import torch
from PIL import UnidentifiedImageError

from worker.ladder import SystemicBatchError, run_with_fallback

ITEMS = [(i, Path(f"img{i}.png")) for i in range(10)]
BAD = Path("img3.png")


def _run(batch_fn):
    return asyncio.run(run_with_fallback(batch_fn, ITEMS, label="test", prepare=lambda: None))


def test_one_unreadable_image_fails_alone() -> None:
    def batch_fn(paths: list[Path]) -> list[str]:
        if BAD in paths:
            msg = "cannot identify image file"
            raise UnidentifiedImageError(msg)
        return [p.name for p in paths]

    successes, failures = _run(batch_fn)
    assert [pid for pid, _ in successes] == [i for i in range(10) if i != 3]
    assert [pid for pid, _ in failures] == [3]


def test_oom_that_fits_in_a_smaller_batch_is_not_a_failure() -> None:
    def batch_fn(paths: list[Path]) -> list[str]:
        if len(paths) > 4:
            msg = "CUDA out of memory"
            raise torch.cuda.OutOfMemoryError(msg)
        return [p.name for p in paths]

    successes, failures = _run(batch_fn)
    assert len(successes) == 10
    assert failures == []


def test_oom_on_a_single_image_fails_the_task_instead_of_blacklisting() -> None:
    """Every input is fixed-size on the GPU, so one image can't be the cause."""

    def batch_fn(paths: list[Path]) -> list[str]:
        msg = "CUDA out of memory"
        raise torch.cuda.OutOfMemoryError(msg)

    with pytest.raises(SystemicBatchError):
        _run(batch_fn)


def test_other_errors_on_a_single_image_stay_per_image() -> None:
    def batch_fn(paths: list[Path]) -> list[str]:
        if BAD in paths:
            msg = "shape mismatch"
            raise RuntimeError(msg)
        return [p.name for p in paths]

    _, failures = _run(batch_fn)
    assert failures == [(3, "RuntimeError: shape mismatch")]


def test_a_failed_load_fails_the_task_not_the_images() -> None:
    def load() -> None:
        msg = "model download failed"
        raise OSError(msg)

    def batch_fn(paths: list[Path]) -> list[str]:
        return [p.name for p in paths]

    with pytest.raises(OSError, match="download"):
        asyncio.run(run_with_fallback(batch_fn, ITEMS, label="test", prepare=load))
