"""Shared torch runtime knobs for the model backends.

``ai.clip``, ``ai.siglip_embed`` and ``ai.siglip_scorer`` all picked the same
device/dtype and (for the two ``transformers`` backbones) carried an identical
copy of the 5.x feature-unwrap patch. Those bits live here once now, so a change
to "where do models run" or "how do we unwrap features" touches one place.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import torch

if TYPE_CHECKING:
    from PIL import Image

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
