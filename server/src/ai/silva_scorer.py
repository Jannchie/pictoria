"""SILVA aesthetic scorer (``Jannchie/silva-aesthetic``).

A third quality scorer kept side-by-side with ``ai.siglip_scorer`` and
``ai.waifu_scorer`` so they can be compared on the same posts. The published
head rides a SigLIP2 backbone (loaded lazily on the first ``score`` call),
independent from the other scorers' backbones — they cannot share weights.

Outputs a single scalar in ``[0, 1]``; the frontend multiplies by 10 for
display to line up with the waifu / SigLIP ~0-10 visual scale. The raw [0, 1]
value is what gets persisted and ordered on.
"""

from __future__ import annotations

import contextlib
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image

from ai.torch_runtime import DEVICE, to_rgb

if TYPE_CHECKING:
    from collections.abc import Sequence

    from silva import AestheticScorer


SCORER_NAME = "silva"
_REPO_ID = "Jannchie/silva-aesthetic"


@cache
def _load() -> AestheticScorer:
    from silva import AestheticScorer  # noqa: PLC0415  # lazy: defer ML stack load

    return AestheticScorer.from_pretrained(_REPO_ID, device=DEVICE)


ImageInput = Image.Image | Path | str


def score_images(inputs: Sequence[ImageInput]) -> list[float]:
    """Score a batch of images. Returns one float per input, in order."""
    if not inputs:
        return []

    scorer = _load()
    opened: list[tuple[Image.Image, bool]] = []
    try:
        for src in inputs:
            if isinstance(src, (str, Path)):
                opened.append((to_rgb(Image.open(src)), True))
            else:
                opened.append((to_rgb(src), False))
        images = [img for img, _ in opened]
        # score() returns a float for a single image and a list for a
        # sequence; we always hand it a list, so the result is a list.
        scores = scorer.score(images)
        return [float(s) for s in scores]
    finally:
        for img, was_opened in opened:
            if was_opened:
                with contextlib.suppress(Exception):
                    img.close()
