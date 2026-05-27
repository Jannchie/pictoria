"""SigLIP-based aesthetic scorer (discus0434/aesthetic-predictor-v2-5).

A second scorer kept side-by-side with ``ai.waifu_scorer`` so the two can be
compared on the same posts. Backbone is ``google/siglip-so400m-patch14-384``
which is independent from ``ai.clip`` (CLIP ViT-L/14) — they cannot share
weights or features.

Outputs a single scalar in roughly 1..10; 5.5+ is considered a strong score
per the upstream README.
"""

from __future__ import annotations

import contextlib
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING

import torch
from aesthetic_predictor_v2_5 import convert_v2_5_from_siglip
from PIL import Image

from ai.torch_runtime import DEVICE, DTYPE, to_rgb

if TYPE_CHECKING:
    from collections.abc import Sequence

    from aesthetic_predictor_v2_5.siglip_v2_5 import (
        AestheticPredictorV2_5Model,
        AestheticPredictorV2_5Processor,
    )


SCORER_NAME = "siglip-v2-5"


@cache
def _load() -> tuple[AestheticPredictorV2_5Model, AestheticPredictorV2_5Processor]:
    model, processor = convert_v2_5_from_siglip(
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    model = model.to(dtype=DTYPE, device=DEVICE)
    model.eval()
    return model, processor


ImageInput = Image.Image | Path | str


def score_images(inputs: Sequence[ImageInput]) -> list[float]:
    """Score a batch of images. Returns one float per input, in order."""
    if not inputs:
        return []

    model, processor = _load()
    opened: list[tuple[Image.Image, bool]] = []
    try:
        for src in inputs:
            if isinstance(src, (str, Path)):
                opened.append((to_rgb(Image.open(src)), True))
            else:
                opened.append((to_rgb(src), False))
        images = [img for img, _ in opened]
        batch = processor(images=images, return_tensors="pt")
        pixel_values = batch.pixel_values.to(dtype=DTYPE, device=DEVICE)
        with torch.inference_mode():
            logits = model(pixel_values).logits
        return logits.squeeze(-1).float().cpu().tolist()
    finally:
        for img, was_opened in opened:
            if was_opened:
                with contextlib.suppress(Exception):
                    img.close()
