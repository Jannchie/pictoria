"""Worker registry — the single declarative list of backfill workers.

Each :class:`WorkerSpec` bundles a worker's identity, batch sizing, GPU-pressure
flag, pending query, batch processor, and — deliberately surfaced as data — its
failure/blacklist policy. ``run_all_backfill`` and ``process_post`` iterate
``WORKERS`` instead of hand-listing every worker in two places.

The batch/mini-batch/per-image fallback ladder and the actual blacklist writes
still live in each worker module (and in ``common.run_batch_with_fallback``);
this module only wires them together and pins the ordering. The
``blacklist_policy`` field is descriptive metadata — it records, as data, what
each worker already does (silva never blacklists; basics one-shot blacklists a
palette failure; the GPU workers run the shared ladder) so the strategy is
visible in one table rather than buried across five modules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from db.repositories.failures import WORKER_EMBEDDING_SIGLIP2
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo
from db.repositories.vectors import VectorRepo
from processors.basics import BASICS_BATCH_SIZE, _list_basics_pending, _process_basics_batch
from processors.common import IMAGE_EXTS, drive
from processors.embedding import SIGLIP_EMBED_BATCH_SIZE, _process_siglip_embedding_batch
from processors.scoring import (
    SILVA_BATCH_SIZE,
    WAIFU_BATCH_SIZE,
    _list_silva_pending,
    _list_waifu_pending,
    _process_silva_batch,
    _process_waifu_batch,
)
from processors.tagger import TAGGER_BATCH_SIZE, _list_tagger_pending, _process_tagger_batch

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Awaitable, Callable

    from rich.progress import Progress

    from db import DB

# ``ladder``   — run the shared batch → mini-batch → per-image fallback and
#                one-shot blacklist the (post, worker) pair that failed.
# ``never``    — a failure is logged but never blacklisted (an embedding that
#                exists should always be scoreable; silva retries next pass).
# ``one_shot`` — the batch processor blacklists bespoke non-ladder failures
#                inline (basics: a palette extraction that left dominant_color
#                NULL, which the pending query would otherwise re-select forever).
BlacklistPolicy = Literal["ladder", "never", "one_shot"]


@dataclass(frozen=True)
class WorkerContext:
    """The repositories a worker may need, sharing one connection.

    A worker only touches the repos it needs; the unused ones are cheap
    idle cursors. ``run_all_backfill`` builds one context per worker (each on
    its own connection, so the workers run concurrently); ``process_post``
    builds a single context from the request-scoped repos it was handed.
    """

    posts: PostRepo
    vectors: VectorRepo
    tag_groups: TagGroupRepo


@dataclass(frozen=True)
class WorkerSpec:
    name: str
    batch_size: int
    gpu_adaptive: bool
    blacklist_policy: BlacklistPolicy
    list_pending: Callable[[WorkerContext], Awaitable[list[int]]]
    process_batch: Callable[[WorkerContext, list[int]], Awaitable[None]]
    # Optional hook fired once after the whole-library backfill of THIS worker
    # completes, receiving the DB and how many posts were pending this run.
    on_backfill_complete: Callable[[DB, int], Awaitable[None]] | None = None


def context_from_connection(conn: sqlite3.Connection) -> WorkerContext:
    """Build a worker context whose repos each get their own cursor on ``conn``.

    Mirrors how ``run_all_backfill`` historically handed each worker its own
    connection (see its docstring): distinct cursors keep per-statement row
    state from desyncing across the worker's ``asyncio.to_thread`` calls.
    """
    return WorkerContext(
        posts=PostRepo(conn.cursor()),
        vectors=VectorRepo(conn.cursor()),
        tag_groups=TagGroupRepo(conn.cursor()),
    )


async def run_worker(
    spec: WorkerSpec,
    ctx: WorkerContext,
    *,
    progress: Progress | None = None,
) -> int:
    """Fetch ``spec``'s pending ids and drive them through its batch processor.

    Returns how many posts were pending this run so the caller can fire
    ``spec.on_backfill_complete`` (e.g. the embedding worker's near-duplicate
    regroup, which is worthwhile only when new embeddings were written).
    """
    pending = await spec.list_pending(ctx)

    async def _process(batch_ids: list[int]) -> None:
        await spec.process_batch(ctx, batch_ids)

    await drive(progress, spec.name, pending, spec.batch_size, _process, gpu_adaptive=spec.gpu_adaptive)
    return len(pending)


# ─── Per-worker pending / batch adapters ─────────────────────────────────
# Thin uniform (ctx) / (ctx, ids) shims over each worker module's own pending
# query and batch processor, so the registry can treat every worker alike.


async def _basics_pending(ctx: WorkerContext) -> list[int]:
    return await _list_basics_pending(ctx.posts)


async def _basics_process(ctx: WorkerContext, ids: list[int]) -> None:
    await _process_basics_batch(ctx.posts, ids)


async def _embedding_pending(ctx: WorkerContext) -> list[int]:
    return await ctx.vectors.list_missing_post_ids(
        image_exts=[ext.lstrip(".") for ext in IMAGE_EXTS],
        worker=WORKER_EMBEDDING_SIGLIP2,
    )


async def _embedding_process(ctx: WorkerContext, ids: list[int]) -> None:
    await _process_siglip_embedding_batch(ctx.posts, ctx.vectors, ids)


async def _tagger_pending(ctx: WorkerContext) -> list[int]:
    return await _list_tagger_pending(ctx.posts)


async def _tagger_process(ctx: WorkerContext, ids: list[int]) -> None:
    await _process_tagger_batch(ctx.posts, ctx.tag_groups, ids)


async def _waifu_pending(ctx: WorkerContext) -> list[int]:
    return await _list_waifu_pending(ctx.posts)


async def _waifu_process(ctx: WorkerContext, ids: list[int]) -> None:
    await _process_waifu_batch(ctx.posts, ids)


async def _silva_pending(ctx: WorkerContext) -> list[int]:
    from ai.silva_scorer import SCORER_NAME  # noqa: PLC0415  # lazy: defer ML stack load

    return await _list_silva_pending(ctx.posts, ctx.vectors, SCORER_NAME)


async def _silva_process(ctx: WorkerContext, ids: list[int]) -> None:
    await _process_silva_batch(ctx.posts, ctx.vectors, ids)


async def _regroup_after_embedding(db: DB, pending_count: int) -> None:
    """Rebuild near-duplicate groups iff this run wrote new embeddings.

    A cold first backfill auto-groups the whole existing library; an idle poll
    embeds nothing, so this is skipped — no wasted GPU. The regroup helper is
    imported lazily to avoid a registry↔pipeline import cycle.
    """
    if pending_count <= 0:
        return
    from processors.pipeline import group_near_duplicates  # noqa: PLC0415

    await group_near_duplicates(db)


# ─── The registry ────────────────────────────────────────────────────────
# Order matches the historical run_all_backfill / process_post ordering.

BASICS_WORKER = WorkerSpec(
    name="Basics",
    batch_size=BASICS_BATCH_SIZE,
    gpu_adaptive=False,
    blacklist_policy="one_shot",
    list_pending=_basics_pending,
    process_batch=_basics_process,
)

EMBEDDING_WORKER = WorkerSpec(
    name="SigLIP embeddings",
    batch_size=SIGLIP_EMBED_BATCH_SIZE,
    gpu_adaptive=True,
    blacklist_policy="ladder",
    list_pending=_embedding_pending,
    process_batch=_embedding_process,
    on_backfill_complete=_regroup_after_embedding,
)

TAGGER_WORKER = WorkerSpec(
    name="Tags",
    batch_size=TAGGER_BATCH_SIZE,
    gpu_adaptive=True,
    blacklist_policy="ladder",
    list_pending=_tagger_pending,
    process_batch=_tagger_process,
)

WAIFU_WORKER = WorkerSpec(
    name="Waifu scorer",
    batch_size=WAIFU_BATCH_SIZE,
    gpu_adaptive=True,
    blacklist_policy="ladder",
    list_pending=_waifu_pending,
    process_batch=_waifu_process,
)

SILVA_WORKER = WorkerSpec(
    name="SILVA scorer",
    batch_size=SILVA_BATCH_SIZE,
    gpu_adaptive=False,
    blacklist_policy="never",
    list_pending=_silva_pending,
    process_batch=_silva_process,
)

WORKERS: tuple[WorkerSpec, ...] = (
    BASICS_WORKER,
    EMBEDDING_WORKER,
    TAGGER_WORKER,
    WAIFU_WORKER,
    SILVA_WORKER,
)
