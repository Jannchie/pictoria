"""Image/text feature extraction helpers (DB-free).

Database access for embeddings lives in ``db.repositories.vectors.VectorRepo``;
this module only runs the forward pass. The encoder is dispatched by
``shared.search_embedding_backend``: ``"clip"`` uses ``ai.clip`` (768d),
``"siglip2"`` uses ``ai.siglip_embed`` (1152d, multilingual). Both ML modules
are imported lazily inside the dispatch so weights aren't loaded when search
isn't used.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import numpy as np

import shared

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path
    from typing import Any


def _text_encoder() -> Callable[..., Any]:
    if shared.search_embedding_backend == "siglip2":
        from ai.siglip_embed import calculate_text_features  # noqa: PLC0415
    else:
        from ai.clip import calculate_text_features  # noqa: PLC0415
    return calculate_text_features


def _image_encoder() -> Callable[..., Any]:
    if shared.search_embedding_backend == "siglip2":
        from ai.siglip_embed import calculate_image_features  # noqa: PLC0415
    else:
        from ai.clip import calculate_image_features  # noqa: PLC0415
    return calculate_image_features


async def get_text_vec(prompt: str) -> np.ndarray:
    """Encode a text prompt into a float32 array (dim follows backend: 768 or 1152)."""
    features = await asyncio.to_thread(_text_encoder(), prompt)
    return features.cpu().numpy()[0].astype(np.float32)


async def get_image_vec(image_path: Path) -> np.ndarray:
    """Encode an image file into a float32 array (dim follows backend: 768 or 1152)."""
    features = await asyncio.to_thread(_image_encoder(), image_path)
    return features.cpu().numpy()[0].astype(np.float32)
