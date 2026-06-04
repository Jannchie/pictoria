"""Near-duplicate grouping — assign each post a canonical representative.

Detection is purely SigLIP 2 driven (the sole image embedding): two posts whose
cosine distance is within ``threshold`` are treated as the same image (covers
different resolutions / encodings and close differentials). A perceptual-hash
verification pass is deliberately deferred (see the design doc) — if the bare
SigLIP 2 threshold turns out to over-group, that is the escape hatch.

Grouping is non-destructive: members keep their rows (so Danbooru de-dup never
re-downloads) and just gain a ``canonical_post_id`` pointer. The earliest post
(smallest id) in a similarity cluster is the canonical; everything else points
at it. Groups are one level deep — never a chain.

Why two code paths:
- ``rebuild_groups`` (batch / existing library): a per-post vec0 KNN is ~1s on a
  170k-row table, so 170k of them is infeasible (~48h, measured). Instead it
  loads every embedding once and finds all near pairs with a chunked GPU
  matrix-multiply (exact cosine over L2-normalised vectors). Deterministic and
  idempotent — re-running it from the same embeddings reproduces the assignment.
- ``assign_group_for_post`` (incremental / a freshly-imported post): a single
  KNN (~1s) is fine for the handful of posts a sync adds, and reuses the vec0
  index directly.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from shared import logger

if TYPE_CHECKING:
    import numpy as np

    from db.repositories.posts import PostRepo
    from db.repositories.vectors import VectorRepo

# Cosine *distance* (1 - cosine_similarity) ceiling for "same image". vec0's
# siglip2 table uses distance_metric=cosine, so identical images score ~0 and
# unrelated ones approach 1. 0.01 (similarity >= 0.99) catches resolution variants
# and close differentials while staying clear of merely-similar art; tune via
# the command's ``threshold`` query param.
DEFAULT_DEDUP_THRESHOLD = 0.01

# Rows per matrix-multiply chunk in the batch. Each chunk materialises a
# (chunk x N) similarity block; 1024 keeps that well under a GB even at N=170k.
DEFAULT_CHUNK_SIZE = 1024

# Neighbours pulled per KNN in the incremental path. Near-duplicate clusters are
# small, so this is ample; only the within-threshold prefix is used.
DEFAULT_KNN_K = 200


def _find_near_pairs(matrix: np.ndarray, threshold: float, chunk_size: int) -> dict[int, list[int]]:
    """Return upper-triangle adjacency: ``{row_idx: [neighbour_idx > row_idx]}``.

    A neighbour is any other row within ``threshold`` cosine distance. Runs a
    chunked ``X @ X.T`` on CUDA when available (fp16), else CPU (fp32). Only the
    upper triangle is kept so the greedy assignment below stays one-directional.
    """
    import torch  # noqa: PLC0415  # lazy: defer the ML stack load until a rebuild runs

    n = matrix.shape[0]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    x = torch.from_numpy(matrix).to(device=device, dtype=dtype)
    # The stored siglip2 vectors are already L2-normalised, but normalise again
    # so cosine similarity == dot product holds exactly regardless of source.
    x = torch.nn.functional.normalize(x, dim=1)
    sim_threshold = 1.0 - threshold

    adjacency: dict[int, list[int]] = {}
    for start in range(0, n, chunk_size):
        end = min(start + chunk_size, n)
        block = x[start:end] @ x.T  # (chunk, n) cosine similarities
        hits = (block >= sim_threshold).nonzero(as_tuple=False)
        if hits.numel() == 0:
            continue
        for local_row, col in hits.cpu().numpy():
            gi = start + int(local_row)
            j = int(col)
            if j > gi:  # upper triangle only (drops self + lower mirror)
                adjacency.setdefault(gi, []).append(j)
    return adjacency


async def rebuild_groups(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    threshold: float = DEFAULT_DEDUP_THRESHOLD,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> int:
    """Recompute every post's group from scratch. Returns members assigned.

    Greedy, ascending id: the first not-yet-claimed post is a canonical seed; its
    within-threshold neighbours (higher id, still unclaimed) join its group.
    Claimed posts never become seeds, so no chains form and the earliest post
    always wins the canonical slot.

    The full assignment is computed first and applied in one atomic swap
    (``replace_all_groups``) at the end — clearing groups up front would leave
    every member visible in listings for the whole GPU pass.
    """
    ids, matrix = await vectors.load_all()
    if len(ids) < 2:  # noqa: PLR2004
        await posts.replace_all_groups([])
        return 0

    adjacency = await _to_thread_find_pairs(matrix, threshold, chunk_size)

    claimed: dict[int, int] = {}  # member_idx -> canonical_idx
    for idx in range(len(ids)):
        if idx in claimed:
            continue
        for j in adjacency.get(idx, ()):  # j > idx by construction
            if j in claimed:
                continue
            claimed[j] = idx

    await posts.replace_all_groups([(ids[m], ids[c]) for m, c in claimed.items()])

    logger.info(
        "Near-duplicate rebuild: %d members grouped under %d canonicals (threshold=%.3f)",
        len(claimed),
        len(set(claimed.values())),
        threshold,
    )
    return len(claimed)


async def _to_thread_find_pairs(
    matrix: np.ndarray, threshold: float, chunk_size: int,
) -> dict[int, list[int]]:
    import asyncio  # noqa: PLC0415

    return await asyncio.to_thread(_find_near_pairs, matrix, threshold, chunk_size)


async def assign_group_for_post(
    posts: PostRepo,
    vectors: VectorRepo,
    post_id: int,
    *,
    threshold: float = DEFAULT_DEDUP_THRESHOLD,
    knn_k: int = DEFAULT_KNN_K,
) -> int | None:
    """Attach a freshly-embedded ``post_id`` to an existing group, if any.

    Best-effort incremental counterpart to ``rebuild_groups`` (the rebuild is the
    authoritative deterministic pass). Points ``post_id`` at the canonical of its
    closest within-threshold neighbour. Returns that canonical id, or ``None``
    when nothing is close enough. Assumes ``post_id`` is currently ungrouped with
    no members of its own (true for a newly-imported post).
    """
    sims = await vectors.similar_to_post(post_id, limit=knn_k)
    for s in sims:
        if s.distance > threshold:
            break  # similar_to_post returns distance-ascending
        neighbour = await posts.get(s.post_id)
        if neighbour is None:
            continue
        canonical_id = neighbour.canonical_post_id or neighbour.id
        if canonical_id == post_id:
            continue  # never point a post at itself
        await posts.set_canonical([post_id], canonical_id)
        return canonical_id
    return None
