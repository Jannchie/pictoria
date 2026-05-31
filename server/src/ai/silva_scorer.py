"""SILVA aesthetic scorer (``Jannchie/silva-aesthetic``).

Scores the published ordinal head DIRECTLY on the SigLIP2 image embeddings
already stored in ``post_vectors_siglip2``. The head's backbone is the same
``google/siglip2-so400m-patch14-384`` ``pooler_output`` that ``ai.siglip_embed``
produces for retrieval, so the stored vectors are exactly the head's training
input — with one twist: we store them L2-normalised (for vec0 cosine), while the
head was trained on raw pooled features. That difference is harmless here because
the head opens with a ``LayerNorm``, which is invariant to the positive scaling
L2-normalisation applies; the normalised vector yields the identical output as the
raw one (verified upstream at cosine 0.9998). The invariance covers the whole
forward — ``logits``, ``score`` and the calibrated path — because everything
downstream of the leading ``LayerNorm`` sees the identical normalised activation.

We read ``calibrated_score``: ``silva>=0.2`` bakes a monotone calibration LUT into
the published head, and the library's own ``SilvaScorer`` facade returns the
calibrated value — so this embedding path stays bit-for-bit consistent with the
end-to-end scorer (it falls back to the raw score when no LUT is baked).

Net effect: scoring skips image decode + the SigLIP2 backbone entirely — it is a
tiny head forward over a ``[B, 1152]`` tensor of already-computed embeddings.

Outputs ``[0, 1]``; the frontend multiplies by 10 for display.
"""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

import numpy as np
import torch

from ai.torch_runtime import DEVICE

if TYPE_CHECKING:
    from collections.abc import Sequence

    from silva import EmbeddingAestheticModel


SCORER_NAME = "silva"
_REPO_ID = "Jannchie/silva-aesthetic"


@cache
def _load_head() -> EmbeddingAestheticModel:
    from silva import EmbeddingAestheticModel  # noqa: PLC0415  # lazy: defer ML stack load

    return EmbeddingAestheticModel.from_pretrained(_REPO_ID).to(DEVICE).eval()


def score_embeddings(embeddings: Sequence[Sequence[float]] | np.ndarray) -> list[float]:
    """Score pre-computed SigLIP2 embeddings, one ``[0, 1]`` float per row.

    ``embeddings`` is ``[N, 1152]``. The stored, L2-normalised vectors are fine
    as-is — the head's leading LayerNorm cancels the normalisation, so no
    re-scaling is needed here.
    """
    arr = np.asarray(embeddings, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.size == 0:
        return []
    head = _load_head()
    with torch.inference_mode():
        x = torch.from_numpy(arr).to(DEVICE)
        scores = head(x)["calibrated_score"]
        return scores.float().cpu().reshape(-1).tolist()
