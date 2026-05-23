"""Adaptive GPU batch sizing based on live memory pressure.

The backfill workers run several heavyweight models (CLIP, WDTagger,
waifu-scorer, optional SigLIP) concurrently. On a 12 GB / 16 GB card the
sum of model footprints plus per-batch activations can put us close to
the OOM cliff; once we cross it CUDA aborts the whole process.

This module samples ``torch.cuda.mem_get_info()`` and returns a batch
size scaled down from the worker's base size when free memory drops
below a tunable threshold. No new dependency — we already require torch.
"""

from __future__ import annotations

from shared import logger

try:
    import torch
    _CUDA_AVAILABLE = torch.cuda.is_available()
except Exception:
    torch = None  # type: ignore[assignment]
    _CUDA_AVAILABLE = False


# Pressure tiers expressed as ``used / total`` fraction:
#   ≥ 0.92  → very tight, drop to 1/4 of base (or 1 minimum)
#   ≥ 0.80  → mild, drop to 1/2
#   else    → full base size
_TIGHT_THRESHOLD = 0.92
_MILD_THRESHOLD = 0.80


def gpu_memory_fraction() -> float | None:
    """Return ``used / total`` for CUDA device 0, or ``None`` if no CUDA."""
    if not _CUDA_AVAILABLE or torch is None:
        return None
    try:
        free, total = torch.cuda.mem_get_info()
    except Exception:
        return None
    if total <= 0:
        return None
    return 1.0 - (free / total)


def adaptive_batch_size(base: int, *, label: str = "gpu") -> int:
    """Scale ``base`` down when the GPU is close to OOM.

    Returns ``base`` unchanged when no CUDA is available — the workers
    still want their normal batches when running on CPU (a CPU OOM is
    swap-bounded, not catastrophic the way a CUDA OOM is).
    """
    if base <= 1:
        return base
    frac = gpu_memory_fraction()
    if frac is None:
        return base
    if frac >= _TIGHT_THRESHOLD:
        scaled = max(1, base // 4)
        logger.warning(
            f"[{label}] GPU memory at {frac:.0%}; shrinking batch {base} → {scaled}",
        )
        return scaled
    if frac >= _MILD_THRESHOLD:
        scaled = max(1, base // 2)
        logger.info(
            f"[{label}] GPU memory at {frac:.0%}; shrinking batch {base} → {scaled}",
        )
        return scaled
    return base
