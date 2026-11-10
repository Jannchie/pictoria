"""Shared torch runtime knobs for the model backends.

``ai.clip`` and ``ai.siglip_embed`` both picked the same
device/dtype and (for the ``transformers`` backbones) carried an identical
copy of the 5.x feature-unwrap patch. Those bits live here once now, so a change
to "where do models run" or "how do we unwrap features" touches one place.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import cache
from typing import TYPE_CHECKING, TypeVar

import torch

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from PIL import Image

T = TypeVar("T")
U = TypeVar("U")

# Single source of truth for where models run and at what precision.
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.bfloat16 if DEVICE == "cuda" else torch.float32


def patch_features_to_tensor(model: object) -> None:
    """Unwrap ``transformers`` 5.x ``get_{image,text}_features`` back to a tensor.

    5.x returns a ``BaseModelOutputWithPooling`` where 4.x returned the bare
    projected-pooled tensor; downstream code expects the tensor, so unwrap
    ``.pooler_output`` uniformly.
    """
    for attr in ("get_image_features", "get_text_features"):
        original = getattr(model, attr, None)
        if original is None:
            continue

        def wrapper(*args: object, _orig: object = original, **kwargs: object) -> object:
            out = _orig(*args, **kwargs)  # type: ignore[operator]
            return getattr(out, "pooler_output", out)

        setattr(model, attr, wrapper)


def to_rgb(img: Image.Image) -> Image.Image:
    return img if img.mode == "RGB" else img.convert("RGB")


#: Decode + preprocess threads, shared by every image model on the GPU queue
#: (SigLIP 2, PixAI, waifu). One pool, not one per model: the GPU queue is
#: ``concurrency=1``, so no two of them preprocess at the same time, and three
#: idle pools would just be 16 more threads in the process. Why 8 is measured in
#: ``ai.siglip_embed`` and ``services.pixai_tagging``.
#:
#: Why parallel at all: the batch runs inside ``asyncio.to_thread`` on a
#: ``concurrency=1`` GPU queue, so the card idles through decode + preprocess.
#: SigLIP at batch=32 measured 0.64 s of forward in a 5.4 s batch — the rest was
#: one CPU thread decoding and resizing image by image.
#:
#: Why threads, not processes: PIL decode and the processors' resize/normalize
#: release the GIL, so threads really run in parallel. A process pool would have
#: to pickle every batch's output across (32x3x384x384 float32 is ~56 MB) and
#: cannot share the model or the CUDA context.
PREPROCESS_WORKERS = 8


@cache
def preprocess_pool() -> ThreadPoolExecutor:
    """The decode pool, built once for the process — **not** once per batch.

    ⚠️ This is the shape that matters, more than the width. A
    ``with ThreadPoolExecutor(...)`` per batch creates and tears down 8 OS
    threads per batch: one batch every ~3 s for 16 h is on the order of 100k
    thread creations, and each fresh caller thread also makes OpenMP build and
    cache a new team for itself. A tagger run died inside exactly that machinery
    — a native access violation with no Python traceback — and a pytest run in
    the same window crashed in ``Thread.start`` itself with 304 live threads in
    the worker process. A pool that is created once churns nothing.
    """
    return ThreadPoolExecutor(max_workers=PREPROCESS_WORKERS, thread_name_prefix="preprocess")


def preprocess_each(fn: Callable[[T], U], items: Sequence[T]) -> list[U | Exception]:
    """``fn`` over ``items`` on :func:`preprocess_pool`, one result **or exception** per item.

    Never raises for one item: the exception comes back in that item's slot, so
    the caller (``worker.ladder``) can fail that image alone instead of decoding
    the whole batch again to find it. Order is the input order.

    ⚠️ ``torch.set_num_threads(1)`` around the pool, restored afterwards. A
    preprocess step that ends in an ATen op (torchvision's resize in PixAI's
    processor, ``return_tensors="pt"`` everywhere) would otherwise have each of
    the 8 pool threads enter torch's 16-way intra-op pool: up to 128 OpenMP
    workers on 24 cores, and calling ATen concurrently from several Python
    threads is the documented-unsafe corner of the OpenMP backend. A tagger run
    died there once (0xC0000005, 40 minutes in, no traceback). Measured free:
    behind 8 concurrent callers the intra-op pool buys nothing, and the output is
    bitwise identical at 16 / 4 / 1 threads. The setting is process-global,
    hence the ``finally``; the GPU queue is ``concurrency=1`` so no sibling GPU
    handler overlaps it.
    """
    prev_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        futures = [preprocess_pool().submit(fn, item) for item in items]
        out: list[U | Exception] = []
        for future in futures:
            try:
                out.append(future.result())
            except Exception as exc:  # collected per item, classified by the caller
                out.append(exc)
        return out
    finally:
        torch.set_num_threads(prev_threads)
