"""Near-duplicate pair finding — the only compute half of dedup.

The rest of ``services/dedup.py`` (loading vectors, greedy assignment, writing
``canonical_post_id``) lives in TS now; what stayed here is the one thing that
needs a GPU: a chunked ``X @ X.T`` over the whole library.

Why the input is a *file* rather than the payload: a per-post vec0 KNN is ~1s on
a 170k-row table, so 170k of them is infeasible (~48h, measured) — the pass needs
every vector in memory at once. 223k by 1152 float32 is 1.0 GB, 1.3 GB base64'd,
which no single JSON row will hold. A raw float32 file threads that needle
without breaking §D1: the worker still opens no database, it just reads the
input it cannot compute.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from pathlib import Path


def find_near_pairs(
    matrix: np.ndarray,
    threshold: float,
    chunk_size: int,
) -> list[list[int]]:
    """Upper-triangle near pairs ``[[i, j], ...]`` with ``i < j``.

    A pair is near when the two rows are within ``threshold`` cosine *distance*.
    Runs on CUDA in fp16 when available, else CPU in fp32. Only the upper
    triangle is kept so the greedy assignment on the TS side stays
    one-directional (and so each pair crosses the boundary once, not twice).
    """
    import torch  # noqa: PLC0415  # lazy: defer the ML stack load until a rebuild runs

    n = matrix.shape[0]
    if n < 2:  # noqa: PLR2004
        return []

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    # ``np.ascontiguousarray`` because the caller may hand over a memmap slice;
    # ``from_numpy`` needs a contiguous buffer and would otherwise raise.
    x = torch.from_numpy(np.ascontiguousarray(matrix)).to(device=device, dtype=dtype)
    # The stored siglip2 vectors are already L2-normalised, but normalise again
    # so cosine similarity == dot product holds exactly regardless of source.
    x = torch.nn.functional.normalize(x, dim=1)
    sim_threshold = 1.0 - threshold

    pairs: list[list[int]] = []
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
                pairs.append([gi, j])
    return pairs


def load_matrix(path: Path, count: int, dim: int) -> np.ndarray:
    """Memory-map the raw float32 matrix file written by the TS side.

    ``memmap`` rather than ``fromfile``: the array is copied to VRAM (or cast to
    fp32 on CPU) anyway, so paying for a second full-size host copy up front buys
    nothing. The size is checked rather than inferred — a short file would
    otherwise reshape into a plausible-looking matrix and silently group the
    wrong posts.
    """
    expected = count * dim * 4
    actual = path.stat().st_size
    if actual != expected:
        msg = f"matrix file is {actual} bytes, expected {expected} ({count}x{dim} float32)"
        raise ValueError(msg)
    return np.memmap(path, dtype=np.float32, mode="r", shape=(count, dim))
