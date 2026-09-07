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
    *,
    max_per_row: int = 0,
) -> list[list[int | float]]:
    """Upper-triangle near pairs ``[[i, j, distance], ...]`` with ``i < j``.

    A pair is near when the two rows are within ``threshold`` cosine *distance*.
    Runs on CUDA in fp16 when available, else CPU in fp32.

    Every pair carries its cosine distance -- the caller sorts the grey band by
    it and stores it as evidence, and there is no cheaper shape worth offering:
    a pair without its distance cannot be told from "already the same image".
    Note the fp16 path: on CUDA the similarities carry ~1e-3 of error, which is
    far below any decision made with these numbers (the 0.01 same-image cut, the
    0.06 grey band, and the arbitration that follows) but is not exact -- the
    stored distance is evidence for ranking and review, not a reproducible key.

    ``max_per_row`` keeps only each row's nearest K neighbours. The grey band
    has no natural bound -- 200 images of one character by one artist can all
    sit within 0.06 of each other, which is 20k pairs from one artist alone --
    and arbitration is per-pair. Truncation is by *union*: a pair survives if
    either side ranks it, so a genuine variant is not lost just because one of
    the two happens to live in a crowded neighbourhood.
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

    lows: list[np.ndarray] = []
    highs: list[np.ndarray] = []
    sims: list[np.ndarray] = []
    for start in range(0, n, chunk_size):
        end = min(start + chunk_size, n)
        block = x[start:end] @ x.T  # (chunk, n) cosine similarities
        if max_per_row > 0:
            # +1 because a row's nearest neighbour is always itself.
            values, indices = block.topk(min(max_per_row + 1, n), dim=1)
            local_rows, slot = (values >= sim_threshold).nonzero(as_tuple=True)
            cols = indices[local_rows, slot]
            hit_sims = values[local_rows, slot]
        else:
            local_rows, cols = (block >= sim_threshold).nonzero(as_tuple=True)
            hit_sims = block[local_rows, cols]
        if local_rows.numel() == 0:
            continue
        rows = local_rows.cpu().numpy().astype(np.int64) + start
        cols_np = cols.cpu().numpy().astype(np.int64)
        keep = rows != cols_np  # drop the self-match
        lows.append(np.minimum(rows, cols_np)[keep])
        highs.append(np.maximum(rows, cols_np)[keep])
        sims.append(hit_sims.float().cpu().numpy()[keep])

    if not lows:
        return []

    low = np.concatenate(lows)
    high = np.concatenate(highs)
    sim = np.concatenate(sims)
    # 折到上三角之后必须去重，而且不能靠"只留 j > i"那个老写法：`max_per_row` 下
    # 一对可能只出现在下三角一侧（j 进了 i 的 top-K，i 没进 j 的），丢掉它就等于
    # 把截断从并集悄悄变成交集。编码成一个 int64 再 unique，比 set of tuples 省内存，
    # 也顺带给出确定的输出顺序。
    codes = low * n + high
    _, first = np.unique(codes, return_index=True)
    return [[int(low[i]), int(high[i]), float(1.0 - sim[i])] for i in first]


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
