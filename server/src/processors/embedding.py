"""SigLIP 2 retrieval-embedding worker — the sole search/retrieval embedding.

Writes into ``post_vectors_siglip2`` (vec0, FLOAT[1152], cosine). CLIP
retrieval and its ``post_vectors`` table were removed (migration 0007).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import numpy as np
from PIL import UnidentifiedImageError

from db.repositories.failures import FailureRepo
from processors.common import FALLBACK_MINI_BATCH_SIZE, IMAGE_EXTS, drive
from shared import logger

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
        worker="embedding:siglip2",
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


async def _process_siglip_embedding_batch(  # noqa: C901, PLR0912
    posts: PostRepo,
    vectors: VectorRepo,
    post_ids: list[int],
) -> None:
    """Encode a batch into SigLIP 2 embeddings written to post_vectors_siglip2.

    On a whole-batch forward failure it first shrinks to mini-batches, then to
    single-image; an unreadable single image is recorded under the
    'embedding:siglip2' one-shot blacklist. ``vectors`` must be a VectorRepo
    pointed at post_vectors_siglip2 (dim=1152).
    """
    from ai.siglip_embed import (  # noqa: PLC0415  # lazy: defer ML stack load
        calculate_image_features,
        calculate_image_features_batch,
    )

    posts_map = await posts.get_many(post_ids)
    items: list[tuple[int, Path]] = []
    for pid in post_ids:
        post = posts_map.get(pid)
        if post is None:
            continue
        abs_path = post.absolute_path
        if abs_path.suffix.lower() not in IMAGE_EXTS or not abs_path.exists():
            continue
        items.append((pid, abs_path))
    if not items:
        return

    paths = [p for _, p in items]
    try:
        features = await asyncio.to_thread(calculate_image_features_batch, paths)
    except Exception as exc:
        logger.warning(
            f"[siglip-embedding] batch failed ({exc!s}); retrying in mini-batches of {FALLBACK_MINI_BATCH_SIZE}",
        )
        failed: list[tuple[int, str, str]] = []
        for i in range(0, len(items), FALLBACK_MINI_BATCH_SIZE):
            chunk = items[i : i + FALLBACK_MINI_BATCH_SIZE]
            chunk_paths = [p for _, p in chunk]
            try:
                chunk_features = await asyncio.to_thread(
                    calculate_image_features_batch,
                    chunk_paths,
                )
            except Exception as exc2:
                logger.warning(
                    f"[siglip-embedding] mini-batch failed ({exc2!s}); falling back per-image",
                )
                for pid, path in chunk:
                    try:
                        single = await asyncio.to_thread(calculate_image_features, path)
                        embedding = single.cpu().numpy()[0].astype(np.float32)
                        await vectors.upsert(pid, embedding)
                    except (UnidentifiedImageError, OSError) as exc3:
                        logger.warning(f"[siglip-embedding] skipping unreadable image {pid} ({path}): {exc3}")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
                    except Exception as exc3:
                        logger.exception(f"[siglip-embedding] post {pid} ({path})")
                        failed.append((pid, "embedding:siglip2", f"{type(exc3).__name__}: {exc3}"))
            else:
                embeddings_np = chunk_features.cpu().numpy().astype(np.float32)
                for (pid, _), emb in zip(chunk, embeddings_np, strict=True):
                    await vectors.upsert(pid, emb)
        if failed:
            await FailureRepo(posts.cur).record_failures(failed)
        return

    embeddings_np = features.cpu().numpy().astype(np.float32)
    for (pid, _), emb in zip(items, embeddings_np, strict=True):
        await vectors.upsert(pid, emb)
