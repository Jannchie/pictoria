"""Image/text feature extraction helpers (DB-free).

Database access for embeddings lives in ``db.repositories.vectors.VectorRepo``;
this module only runs the forward pass. Search uses SigLIP 2
(``ai.siglip_embed``, 1152d, multilingual text); the ML module is imported
lazily so weights aren't loaded when search isn't used.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from pathlib import Path


async def get_text_vec(prompt: str) -> np.ndarray:
    """Encode a text prompt into a float32 array (SigLIP 2, 1152d)."""
    from ai.siglip_embed import calculate_text_features  # noqa: PLC0415  # lazy: defer ML stack load

    features = await asyncio.to_thread(calculate_text_features, prompt)
    return features.cpu().numpy()[0].astype(np.float32)


async def get_image_vec(image_path: Path) -> np.ndarray:
    """Encode an image file into a float32 array (SigLIP 2, 1152d)."""
    from ai.siglip_embed import calculate_image_features  # noqa: PLC0415  # lazy: defer ML stack load

    features = await asyncio.to_thread(calculate_image_features, image_path)
    return features.cpu().numpy()[0].astype(np.float32)
