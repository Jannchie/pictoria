"""CLIP feature extraction helpers (DB-free).

Database access for embeddings lives in ``db.repositories.vectors.VectorRepo``;
this module only handles the CLIP forward pass for text and image inputs.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import numpy as np

from ai.clip import calculate_image_features, calculate_text_features

if TYPE_CHECKING:
    from pathlib import Path


async def get_text_vec(prompt: str) -> np.ndarray:
    """Encode a text prompt into a 768-d float32 array compatible with
    ``post_vectors.embedding``.
    """
    features = await asyncio.to_thread(calculate_text_features, prompt)
    return features.cpu().numpy()[0].astype(np.float32)


async def get_image_vec(image_path: Path) -> np.ndarray:
    """Encode an image file into a 768-d float32 array."""
    features = await asyncio.to_thread(calculate_image_features, image_path)
    return features.cpu().numpy()[0].astype(np.float32)
