"""Tests for the SigLIP 2 embedding module.

Structure tests always run; the inference smoke test needs CUDA + downloaded
weights, so it is skipped otherwise.
"""

from __future__ import annotations

import importlib

import pytest


def test_module_exposes_public_api() -> None:
    mod = importlib.import_module("ai.siglip_embed")
    assert mod.EMBED_DIM == 1152
    for name in (
        "calculate_image_features",
        "calculate_image_features_batch",
        "calculate_text_features",
    ):
        assert callable(getattr(mod, name)), name


@pytest.mark.skipif(
    "not __import__('torch').cuda.is_available()",
    reason="SigLIP 2 forward needs CUDA + downloaded weights",
)
def test_text_features_shape() -> None:
    from ai.siglip_embed import EMBED_DIM, calculate_text_features

    feats = calculate_text_features(["一只猫", "a cat"])
    assert feats.shape == (2, EMBED_DIM)


@pytest.mark.skipif(
    "not __import__('torch').cuda.is_available()",
    reason="SigLIP 2 forward needs CUDA + downloaded weights",
)
def test_image_features_shape_and_finite() -> None:
    # The backfill worker encodes images then numpy().astype(float32) before
    # upsert; mirror that and assert the output is well-formed.
    import numpy as np
    from PIL import Image

    from ai.siglip_embed import EMBED_DIM, calculate_image_features_batch

    imgs = [Image.new("RGB", (64, 64), (i * 40, 80, 200)) for i in range(2)]
    feats = calculate_image_features_batch(imgs)
    assert feats.shape == (2, EMBED_DIM)
    arr = feats.cpu().numpy().astype(np.float32)
    assert np.isfinite(arr).all()
