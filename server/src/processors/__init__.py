"""Post-processing backfill, split into independent workers.

Each metadata type (basics, SigLIP 2 embedding, WDTagger tags, waifu score) is
handled by its own worker with its own ``WHERE … IS NULL`` style pending
predicate and its own progress bar. Workers run concurrently as asyncio
tasks sharing a single ``rich.Progress`` display, so the CLI shows one
bar per active worker stacked vertically.

Module map
----------
- ``pipeline``: orchestration — ``sync_metadata`` (disk reconcile + backfill),
  ``run_all_backfill`` (all workers concurrently), ``process_post`` (single
  freshly-uploaded post, reusing the same batch functions).
- ``common``: shared constants (image-extension filters) and ``drive``, the
  chunked batch driver with progress + GPU-pressure-adaptive sizing.
- ``basics`` / ``embedding`` / ``tagger`` / ``scoring``: one module per worker
  (scoring bundles waifu + SILVA) — each owns its pending query, batch
  processor, and fallback strategy.
- ``gpu_pressure``: free-VRAM sampling used by ``drive``'s adaptive batches.

Design notes
------------
- "Basics" stays bundled (sha256 + arthash + dimensions + palette +
  dominant_color) because all of these piggyback on a single file open
  / PIL decode — splitting them would re-decode the same image up to
  four times.
- No per-worker thread-pool sizing: each worker just hands its sync
  payload to the global ``asyncio.to_thread`` executor as before.
"""

from processors.common import IMAGE_EXTS
from processors.pipeline import process_post, run_all_backfill, sync_metadata
from processors.registry import WORKERS, WorkerContext, WorkerSpec, run_worker

__all__ = [
    "IMAGE_EXTS",
    "WORKERS",
    "WorkerContext",
    "WorkerSpec",
    "process_post",
    "run_all_backfill",
    "run_worker",
    "sync_metadata",
]
