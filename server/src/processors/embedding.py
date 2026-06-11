"""SigLIP 2 retrieval-embedding worker — the sole search/retrieval embedding.

Writes into ``post_vectors_siglip2`` (vec0, FLOAT[1152], cosine). CLIP
retrieval and its ``post_vectors`` table were removed (migration 0007).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from db.repositories.failures import WORKER_EMBEDDING_SIGLIP2, FailureRepo
from processors.common import IMAGE_EXTS, build_image_items, drive, run_batch_with_fallback

if TYPE_CHECKING:
    from pathlib import Path

    from rich.progress import Progress

    from db.repositories.posts import PostRepo
    from db.repositories.vectors import VectorRepo

# SigLIP 2 so400m is a larger ViT than CLIP-L/14; batch=16 fits 12GB at bf16.
SIGLIP_EMBED_BATCH_SIZE = 16


async def run_siglip_embedding_worker(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    progress: Progress | None = None,
) -> int:
    """Backfill SigLIP 2 image embeddings into post_vectors_siglip2.

    ``vectors`` must be a VectorRepo pointed at post_vectors_siglip2 (dim=1152).
    Returns how many posts were pending (i.e. how many new embeddings this run
    attempted) so the caller can decide whether a near-duplicate regroup is
    worthwhile — a 0 means nothing changed and the regroup can be skipped.
    """
    pending = await vectors.list_missing_post_ids(
        image_exts=[ext.lstrip(".") for ext in IMAGE_EXTS],
        worker=WORKER_EMBEDDING_SIGLIP2,
    )

    async def _process(batch_ids: list[int]) -> None:
        await _process_siglip_embedding_batch(posts, vectors, batch_ids)

    await drive(
        progress,
        "SigLIP embeddings",
        pending,
        SIGLIP_EMBED_BATCH_SIZE,
        _process,
        gpu_adaptive=True,
    )
    return len(pending)


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
    if failures:
        await FailureRepo(posts.cur).record_failures(
            [(pid, WORKER_EMBEDDING_SIGLIP2, err) for pid, err in failures],
        )
