"""Quality-score workers: waifu (image-based) and SILVA (embedding-based)."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from db.repositories.failures import WORKER_WAIFU, FailureRepo, aesthetic_worker, not_failed_clause
from db.repositories.scores import ScoreRepo
from processors.common import IMAGE_EXT_WHERE, build_image_items, drive, run_batch_with_fallback
from shared import logger

if TYPE_CHECKING:
    from rich.progress import Progress

    from db.repositories.posts import PostRepo
    from db.repositories.vectors import VectorRepo

WAIFU_BATCH_SIZE = 32
# SILVA scores stored embeddings (no image decode / backbone) — a pure head
# forward, so batches can be large and cheap.
SILVA_BATCH_SIZE = 256


async def run_waifu_worker(
    posts: PostRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the waifu quality score into ``post_waifu_scores``."""
    pending = await _list_waifu_pending(posts)

    async def _process(batch_ids: list[int]) -> None:
        await _process_waifu_batch(posts, batch_ids)

    await drive(
        progress,
        "Waifu scorer",
        pending,
        WAIFU_BATCH_SIZE,
        _process,
        gpu_adaptive=True,
    )


async def run_silva_worker(
    posts: PostRepo,
    vectors: VectorRepo,
    *,
    progress: Progress | None = None,
) -> None:
    """Backfill the SILVA aesthetic score from stored SigLIP2 embeddings.

    Pending = posts that already have a ``post_vectors_siglip2`` embedding but no
    ``silva`` score yet. Scoring reuses that embedding (see ``ai.silva_scorer``),
    so this worker never opens the image files or loads the SigLIP2 backbone.
    """
    from ai.silva_scorer import SCORER_NAME  # noqa: PLC0415  # lazy: defer ML stack load

    pending = await _list_silva_pending(posts, vectors, SCORER_NAME)

    async def _process(batch_ids: list[int]) -> None:
        await _process_silva_batch(posts, vectors, batch_ids)

    await drive(progress, "SILVA scorer", pending, SILVA_BATCH_SIZE, _process)


# ─── Pending queries ────────────────────────────────────────────────────


async def _list_waifu_pending(posts: PostRepo) -> list[int]:
    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id
            WHERE pws.post_id IS NULL
              AND {IMAGE_EXT_WHERE}
              AND {not_failed_clause("p")}
            ORDER BY p.id
            """,  # noqa: S608
            [WORKER_WAIFU],
        )
        return [r[0] for r in posts.cur.fetchall()]

    return await asyncio.to_thread(_impl)


async def _list_silva_pending(posts: PostRepo, vectors: VectorRepo, scorer: str) -> list[int]:
    """Posts that have a SigLIP2 embedding but no ``scorer`` aesthetic score.

    SILVA scores the *embedding*, not the image, so it requires one to exist.
    The "has an embedding?" check is a Python set-intersection against one
    scan of the vec0 post_id column (``embedded_post_ids_sync``) rather than a
    per-row ``EXISTS``: a vec0 lookup is a virtual-table probe, not a B-tree
    probe, so probing once per posts row took tens of seconds at library
    scale. Candidate order (``p.id`` ascending) is preserved by the filter.
    """

    def _impl() -> list[int]:
        posts.cur.execute(
            f"""
            SELECT p.id FROM posts p
            WHERE NOT EXISTS (
                SELECT 1 FROM post_aesthetic_scores pas
                WHERE pas.post_id = p.id AND pas.scorer = ?
              )
              AND {not_failed_clause("p")}
            ORDER BY p.id
            """,  # noqa: S608
            [scorer, aesthetic_worker(scorer)],
        )
        candidates = [r[0] for r in posts.cur.fetchall()]
        embedded = vectors.embedded_post_ids_sync()
        return [pid for pid in candidates if pid in embedded]

    return await asyncio.to_thread(_impl)


# ─── Batch processors ───────────────────────────────────────────────────


async def _process_waifu_batch(posts: PostRepo, post_ids: list[int]) -> None:
    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer ML stack load

    scorer = get_waifu_scorer()
    posts_map = await posts.get_many(post_ids)
    items = [(pid, path) for pid, _, path in build_image_items(posts_map, post_ids)]
    if not items:
        return

    raw, failures = await run_batch_with_fallback(
        scorer,
        items,
        worker_label=WORKER_WAIFU,
    )
    if raw:
        await ScoreRepo(posts.cur).upsert_waifu_scores_many([(pid, float(score)) for pid, score in raw])
    if failures:
        await FailureRepo(posts.cur).record_failures([(pid, WORKER_WAIFU, err) for pid, err in failures])


async def _process_silva_batch(posts: PostRepo, vectors: VectorRepo, post_ids: list[int]) -> None:
    """Score a batch from stored SigLIP2 embeddings (no image decode / backbone).

    Posts without a stored embedding are silently skipped — they get scored on a
    later pass, once the embedding worker has filled them in. A head-forward
    failure is logged but not blacklisted: an embedding that exists should always
    be scoreable, so a failure is a transient/code problem worth retrying, not
    bad data to permanently skip.
    """
    from ai.silva_scorer import SCORER_NAME, score_embeddings  # noqa: PLC0415  # lazy: defer ML stack load

    emb_map = await vectors.get_many(post_ids)
    items = [(pid, emb_map[pid]) for pid in post_ids if pid in emb_map]
    if not items:
        return

    pids = [pid for pid, _ in items]
    embeddings = [emb for _, emb in items]
    try:
        scores = await asyncio.to_thread(score_embeddings, embeddings)
    except Exception:
        logger.exception(f"[silva] head forward failed for {len(pids)} posts starting at id {pids[0]}")
        return

    await ScoreRepo(posts.cur).upsert_aesthetic_scores_many(
        SCORER_NAME,
        [(pid, float(score)) for pid, score in zip(pids, scores, strict=True)],
    )
