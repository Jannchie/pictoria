"""SigLIP 2 retrieval-embedding worker — the sole search/retrieval embedding.

Writes into ``post_vectors_siglip2`` (vec0, FLOAT[1152], cosine). CLIP
retrieval and its ``post_vectors`` table were removed (migration 0007).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from db.repositories.failures import WORKER_EMBEDDING_SIGLIP2
from processors.common import build_image_items, record_pair_failures, run_batch_with_fallback

if TYPE_CHECKING:
    from pathlib import Path

    from db.repositories.posts import PostRepo
    from db.repositories.vectors import VectorRepo

# SigLIP 2 so400m is a larger ViT than CLIP-L/14; batch=16 fits 12GB at bf16.
SIGLIP_EMBED_BATCH_SIZE = 16


async def _process_siglip_embedding_batch(
    posts: PostRepo,
    vectors: VectorRepo,
    post_ids: list[int],
) -> None:
    """Encode a batch into SigLIP 2 embeddings written to post_vectors_siglip2.

    Runs the shared batch → mini-batch → per-image fallback ladder; an
    unreadable image is recorded under the ``embedding:siglip2`` one-shot
    blacklist. Successful embeddings are persisted in one batched upsert at
    the end, so a persistence error propagates to the driver instead of
    blacklisting the post. ``vectors`` must be a VectorRepo pointed at
    post_vectors_siglip2 (dim=1152).
    """
    from ai.siglip_embed import calculate_image_features_batch  # noqa: PLC0415  # lazy: defer ML stack load

    posts_map = await posts.get_many(post_ids)
    items = [(pid, path) for pid, _, path in build_image_items(posts_map, post_ids)]
    if not items:
        return

    def _encode(paths: list[Path]) -> list[np.ndarray]:
        features = calculate_image_features_batch(paths)
        return list(features.cpu().numpy().astype(np.float32))

    successes, failures = await run_batch_with_fallback(
        _encode,
        items,
        worker_label="siglip-embedding",
    )
    if successes:
        await vectors.upsert_many([(pid, emb.tolist()) for pid, emb in successes])
    await record_pair_failures(posts.cur, WORKER_EMBEDDING_SIGLIP2, failures)
