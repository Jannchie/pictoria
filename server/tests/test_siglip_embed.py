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
