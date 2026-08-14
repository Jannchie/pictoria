"""SILVA aesthetic scorers (``Jannchie/silva-aesthetic``, ``Jannchie/silva-luna``).

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

Two heads ship here — ``silva`` and ``silva_luna`` — identical in architecture
and output domain but distilled from *different* judges, so they are two tastes
rather than two quality tiers. Each is keyed by its registry
:class:`~scorers.ScorerSpec` name and cached independently, so a library can
carry both scores and be sorted or filtered by either.
"""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

import numpy as np
import torch

from ai.torch_runtime import DEVICE
from scorers import SILVA, SILVA_LUNA

if TYPE_CHECKING:
    from collections.abc import Sequence

    from silva import EmbeddingAestheticModel


SCORER_NAME = SILVA.name
LUNA_SCORER_NAME = SILVA_LUNA.name

# Registry scorer name -> published head. Both are ~7 MB ordinal heads over the
# same frozen SigLIP2 backbone, so a process can hold both resident.
_REPO_IDS: dict[str, str] = {
    SCORER_NAME: "Jannchie/silva-aesthetic",
    LUNA_SCORER_NAME: "Jannchie/silva-luna",
}


@cache
def _load_head(scorer: str) -> EmbeddingAestheticModel:
    from silva import EmbeddingAestheticModel  # noqa: PLC0415  # lazy: defer ML stack load

    return EmbeddingAestheticModel.from_pretrained(_REPO_IDS[scorer]).to(DEVICE).eval()


def score_embeddings(
    embeddings: Sequence[Sequence[float]] | np.ndarray,
    scorer: str = SCORER_NAME,
) -> list[float]:
    """Score pre-computed SigLIP2 embeddings, one ``[0, 1]`` float per row.

    ``embeddings`` is ``[N, 1152]``. The stored, L2-normalised vectors are fine
    as-is — the head's leading LayerNorm cancels the normalisation, so no
    re-scaling is needed here. ``scorer`` picks which published head to run;
    it is a registry name (``silva`` / ``silva_luna``), not caller input.
    """
    arr = np.asarray(embeddings, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.size == 0:
        return []
    head = _load_head(scorer)
    with torch.inference_mode():
        x = torch.from_numpy(arr).to(DEVICE)
        scores = head(x)["calibrated_score"]
        return scores.float().cpu().reshape(-1).tolist()
