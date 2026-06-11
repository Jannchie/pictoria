"""Text feature extraction helper (DB-free).

Database access for embeddings lives in ``db.repositories.vectors.VectorRepo``;
this module only runs the forward pass. Search uses SigLIP 2
(``ai.siglip_embed``, 1152d, multilingual text); the ML module is imported
lazily so weights aren't loaded when search isn't used. Image encoding lives
with the embedding worker (``processors.embedding``).
"""

from __future__ import annotations

import asyncio

import numpy as np


async def get_text_vec(prompt: str) -> np.ndarray:
    """Encode a text prompt into a float32 array (SigLIP 2, 1152d)."""
    from ai.siglip_embed import calculate_text_features  # noqa: PLC0415  # lazy: defer ML stack load

    features = await asyncio.to_thread(calculate_text_features, prompt)
    return features.cpu().numpy()[0].astype(np.float32)
