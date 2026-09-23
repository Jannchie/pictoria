"""PixAI Tagger v1.0 — the auto-tagging forward pass (DB-free).

Replaced ``wd_tagging`` (``SmilingWolf/wd-vit-large-tagger-v3``) on 2026-09-22.
What the swap buys, from the model card's own common-tag benchmark (8,407 shared
General tags over 50,416 images): General micro-F1 0.666 against 0.6435 for the
runner-up, a May 2026 training cut-off against WD v3's early-2024 one, and two
tag categories WD never produced at all — ``style`` (artist, micro-F1 0.814) and
``copyright``. The library's ``artist`` / ``copyright`` tag groups existed and
were only ever filled by the Danbooru importer; now the tagger fills them too.

Thresholds live **here**, not in TS, and that is deliberate. §D1 puts schema
decisions in TS — which group a tag name belongs to, whether a rating may
overwrite a stored one — and those are still decided there. A per-category
sigmoid cut-off is not a schema decision, it is part of the model: these six
numbers are the macro-F1 optima the authors published *with the weights*, and
they ship inside ``config.json`` as ``category_best_threshold``. The alternative
is shipping 30,877 probabilities per image through the queue (≈ 4 MB a batch,
against a few KB of tag names) so TS can apply a number it read off the same
config file.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import cache
from typing import TYPE_CHECKING, Any

import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel

from ai.hf_loader import load_local_first
from ai.torch_runtime import DEVICE, DTYPE

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

log = logging.getLogger("services.pixai_tagging")

MODEL_ID = "pixai-labs/pixai-tagger-v1.0"

#: Written into ``posts.tagger`` by the TS side so a future model swap can find
#: the rows this one produced. Bump it together with :data:`MODEL_ID`.
MODEL_TAG = "pixai-tagger-v1.0"

#: The model's own five tag categories, in the order the head lays them out.
#: ``style`` is PixAI's name for what this library's schema calls ``artist``;
#: the rename is a schema decision, so it happens in TS.
TAG_CATEGORIES = ("general", "character", "copyright", "style", "meta")

#: ``rating:*`` label → the word this library's ``ratingToInt`` expects.
RATING_LABELS = {
    "rating:g": "general",
    "rating:s": "sensitive",
    "rating:q": "questionable",
    "rating:e": "explicit",
}

#: Decode + pad threads. Same *shape* of win as ``siglip_embed`` — the GPU queue
#: is ``concurrency=1``, so single-threaded decoding leaves the card idle — but
#: not the same profile, and the difference matters:
#:
#: ``siglip_embed``'s processor resizes with PIL and only then builds a tensor, so
#: a thread costs a 384x384 float32 (1.7 MB). ``RescalePadProcessor`` does it the
#: other way round: ``to_tensor`` on the **full-resolution** image, then a
#: torchvision resize. A 38 Mpx library PNG is a 462 MB float32 before it is
#: touched, and the resize is an ATen op on that.
#:
#: Measured on the batch a crashed run died on (16 images, 8-38 Mpx, mostly RGBA):
#: 8 threads 4.10 s, threaded-decode-with-serial-resize 5.92 s, fully serial
#: 10.27 s — peak RSS +2.13 GiB, which is not close to a limit on this box. So 8
#: stays; what had to change is how the 8 are *managed* (``_pool``) and the
#: intra-op pool they are paired with (``tag_batch``).
PREPROCESS_WORKERS = 8

@dataclass(frozen=True, slots=True)
class TagResult:
    """One image's tags, keyed by the **model's** category names.

    ``rating`` is one of ``general`` / ``sensitive`` / ``questionable`` /
    ``explicit``, or ``""`` when no rating logit cleared its threshold.
    """

    tags: dict[str, list[str]]
    rating: str


# ``Any``, not ``AutoModel``: the auto-classes are factories, so a checkpoint's
# ``trust_remote_code`` class (here ``ViTDetCls`` / ``RescalePadProcessor``, both
# defined in the repo's ``tagger_pipeline.py``) has no static type to name.
@cache
def _get_model() -> Any:
    """Load the weights in bf16 on the GPU.

    ⚠️ Two deviations from ``siglip_embed.get_model``, both of them load-bearing,
    both found by diffing this path's probabilities against the model card's own
    ``pipeline(...)`` on the same image:

    * ``dtype=`` on ``from_pretrained``, **not** ``.to(dtype=DTYPE)`` afterwards.
      This architecture's attention keeps its RoPE frequencies in a *complex*
      buffer (``Attention._setup_rope_freqs``). ``.to(dtype=bfloat16)`` casts
      every buffer, so it throws the imaginary part away — torch says so, in a
      ``UserWarning`` among the load noise, and then happily returns tags. They
      are simply wrong: a 1girl illustration came back ``no_humans, abstract``,
      max probability difference 0.97 against the reference. ``from_pretrained``
      casts only the floating-point weights and leaves complex buffers alone.
    * ``.to(DEVICE)``, **not** ``device_map=DEVICE``. Accelerate's device map
      leaves those same RoPE buffers on the CPU and the forward dies with "found
      at least two devices, cuda:0 and cpu".

    With both in place this path is bit-identical to the reference pipeline.
    """
    model = load_local_first(AutoModel.from_pretrained, MODEL_ID, trust_remote_code=True, dtype=DTYPE)
    model = model.to(DEVICE)
    model.eval()
    return model


@cache
def _get_processor() -> Any:
    return load_local_first(AutoImageProcessor.from_pretrained, MODEL_ID, trust_remote_code=True)


@cache
def _pool() -> ThreadPoolExecutor:
    """The decode pool, built once for the process — **not** once per batch.

    ⚠️ This is the shape that matters, more than the width. A
    ``with ThreadPoolExecutor(...)`` inside ``tag_batch`` creates and tears down
    8 OS threads *per batch*: one batch every ~3 s for 16 h is on the order of
    100k thread creations, and each fresh caller thread also makes OpenMP build
    and cache a new team for itself. A run died inside exactly that machinery
    — a native access violation with no Python traceback — and a pytest run in
    the same window crashed in ``Thread.start`` itself, under ``transformers``'
    parallel weight loader, with 304 live threads in the worker process.
    A pool that is created once churns nothing.
    """
    return ThreadPoolExecutor(max_workers=PREPROCESS_WORKERS, thread_name_prefix="pixai-pre")


@cache
def _get_layout() -> tuple[list[str], torch.Tensor, list[tuple[str, int]]]:
    """``(tag names, per-logit threshold, [(category, count)])`` for the loaded head.

    All three come out of the checkpoint's own config, so a model bump carries
    its vocabulary and its cut-offs with it and this file needs no edit.
    """
    config = _get_model().config
    per_category: dict[str, float] = config.category_best_threshold
    thresholds = torch.cat([
        torch.full((count,), per_category[category], dtype=torch.float32)
        for category, count in config.tags_split
    ])
    return list(config.tags), thresholds, [(c, int(n)) for c, n in config.tags_split]


def warm() -> None:
    """Load the weights (~1.9 GB), the layout and the decode pool. Off-loop."""
    _get_model()
    _get_processor()
    _get_layout()
    _pool()


def _open_padded(path: Path) -> torch.Tensor:
    """Decode one image and run the model's own resize-pad-normalise on it.

    ``RescalePadProcessor`` fits the long side to 1008 and pads the short one
    with black, so every image comes out 1008x1008 and per-image tensors
    concatenate exactly like a whole-batch call would have produced. It is fed
    the *unmodified* PIL image on purpose: pre-shrinking with PIL first looks
    equivalent and is not — its resampling differs from torchvision's, and on
    real library images that moved individual tag probabilities by up to 0.45,
    against a bf16 noise floor of exactly 0.0.
    """
    with Image.open(path) as image:
        image.load()
        return _get_processor()(image, return_tensors="pt").pixel_values


def tag_batch(paths: Sequence[Path]) -> list[TagResult]:
    """Tag a batch of images in one GPU forward; one :class:`TagResult` per path.

    Decode and preprocess run on a thread pool while the GPU queue's single
    slot would otherwise idle — the same split ``siglip_embed`` documents at
    length. Raises on an unreadable image and lets ``run_with_fallback`` shrink
    the batch; it persists nothing.
    """
    if not paths:
        return []

    tags, thresholds, splits = _get_layout()
    # ⚠️ ``torch.set_num_threads(1)`` around the pool, restored afterwards.
    #
    # The preprocess half ends in an ATen op (torchvision's resize), and torch's
    # intra-op pool is 16 threads on this machine. Eight pool threads each
    # entering a 16-way parallel region is up to 128 OpenMP workers fighting over
    # 24 cores, and calling ATen ops concurrently from several Python threads is
    # the documented-unsafe corner of the OpenMP backend. A run died there once:
    # a native access violation (0xC0000005) 40 minutes in, no Python traceback,
    # cairnq's ``running`` row naming a tagger task. Not *proven* to be the cause
    # — it was not reproducible standalone — but it is the one mechanism that fits
    # the evidence, and closing it is free.
    #
    # Free is measured, not assumed: behind 8 concurrent callers the intra-op pool
    # buys nothing, because they already saturate the cores between them. Same
    # batch, best of 3 — 16 threads 3.80 s vs 1 thread 3.48 s (big images), 1.09 s
    # vs 1.14 s (typical ones). Output is bitwise identical at 16 / 4 / 1 threads
    # (``torch.equal``), as it has to be: resize splits output rows across threads
    # and each row's arithmetic is independent.
    #
    # It is process-global, hence the ``finally``. The GPU queue is
    # ``concurrency=1`` so no sibling GPU handler overlaps this; an ``io`` handler
    # can, and would briefly see one intra-op thread. That is a blip in a
    # thumbnail, against a crash that costs the whole batch.
    prev_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        tiles = list(_pool().map(_open_padded, paths))
    finally:
        torch.set_num_threads(prev_threads)

    pixel_values = torch.cat(tiles, dim=0).to(DEVICE, DTYPE)
    with torch.inference_mode():
        # .float() before sigmoid: the card's recipe is a bf16 forward with an
        # fp32 sigmoid, and the thresholds are tuned against that.
        probs = _get_model()(pixel_values).float().sigmoid()

    probs = probs.cpu()
    hits = probs > thresholds
    return [_decode(probs[i], hits[i], tags, splits) for i in range(len(paths))]


def _decode(
    probs: torch.Tensor,
    hits: torch.Tensor,
    tags: list[str],
    splits: list[tuple[str, int]],
) -> TagResult:
    """Turn one image's boolean hit mask into names per category plus a rating."""
    out: dict[str, list[str]] = {category: [] for category in TAG_CATEGORIES}
    rating = ""
    start = 0
    for category, count in splits:
        indices = hits[start : start + count].nonzero().flatten().tolist()
        if category == "rating":
            # Four mutually exclusive logits, and more than one can clear 0.41.
            # Highest wins; an unknown label is dropped rather than guessed at.
            if indices:
                best = max(indices, key=lambda i: probs[start + i].item())
                rating = RATING_LABELS.get(tags[start + best], "")
        elif category in out:
            out[category] = [tags[start + i] for i in indices]
        else:
            log.warning("unknown tag category %r in the checkpoint, ignored", category)
        start += count
    return TagResult(tags=out, rating=rating)
