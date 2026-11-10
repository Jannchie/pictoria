"""The waifu quality scorer (CLIP ViT-L/14 + ``Eugeoter/waifu-scorer-v3``'s MLP).

The package's own ``WaifuScorer.predict`` opens, pastes on white and
preprocesses its images one after another on the calling thread, then runs one
whole-batch CLIP processor call — with the GPU queue at ``concurrency=1`` the
card sits idle through all of it. So the two halves are re-done here, around the
package's own pieces:

* :func:`preprocess` — open + ``convert_to_rgb`` (transparency onto white) +
  ``rotate_image_straight`` (EXIF orientation) + the CLIP processor on **one**
  image, in parallel on the shared pool. Exactly ``WaifuScorer.get_image``
  followed by ``encode_images``' processor call; the CLIP image processor
  resizes and centre-crops every image to 224x224 independently, so a per-image
  call concatenates to the same tensor a whole-batch call would have produced.
* :func:`score_tiles` — ``get_image_features`` → the package's ``normalized`` →
  ``WaifuScorer.inference`` (MLP + clamp), in **fp32** as before: the scores
  already stored were produced in fp32 and new ones have to sit next to them.
"""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

import torch
from PIL import Image
from waifu_scorer.predict import WaifuScorer, convert_to_rgb, normalized, rotate_image_straight

from ai.clip import get_clip_model, get_processor
from ai.torch_runtime import preprocess_each, preprocess_pool

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path


@cache
def get_waifu_scorer() -> WaifuScorer:
    return WaifuScorer(clip_model=get_clip_model(), clip_processor=get_processor())


def warm() -> None:
    """Load CLIP + the MLP and build the decode pool. Off-loop, before the ladder."""
    get_waifu_scorer()
    preprocess_pool()


def _preprocess_one(path: Path) -> torch.Tensor:
    """One image to its ``(1, 3, 224, 224)`` fp32 pixel values."""
    with Image.open(path) as opened:
        # The order is ``WaifuScorer.get_image``'s: white background first, then
        # the EXIF rotation. convert_to_rgb always returns a new image, so the
        # file can be closed before the processor runs.
        image = rotate_image_straight(convert_to_rgb(opened))
    return get_waifu_scorer().preprocess(images=[image], return_tensors="pt")["pixel_values"]


def preprocess(paths: Sequence[Path]) -> list[torch.Tensor | Exception]:
    """The decode half: one tile **or exception** per path, in order."""
    return preprocess_each(_preprocess_one, paths)


def score_tiles(tiles: Sequence[torch.Tensor]) -> list[float]:
    """The forward half: CLIP image features → L2-normalise → MLP, one score per tile."""
    if not tiles:
        return []
    scorer = get_waifu_scorer()
    pixel_values = torch.cat(list(tiles), dim=0).to(scorer.device)
    with torch.no_grad():
        # ``ai.clip`` patched get_image_features to return the bare tensor.
        features = scorer.clip.get_image_features(pixel_values=pixel_values)
    return scorer.inference(normalized(features).cpu().float())
