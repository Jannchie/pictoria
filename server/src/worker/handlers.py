"""cairnq task handlers — the compute half of the refactor.

Every handler here obeys one rule, the one that decides the whole design (see
``docs/refactor-monorepo-hono.md`` §D1):

    **All compute in the Python worker, all database writes in TS. No exceptions.**

So a handler takes everything it needs from the payload (paths, vectors),
returns plain data, and never opens ``pictoria.sqlite``. That is what lets the
Python ``db/`` layer be deleted whole in Phase 7 rather than surviving as a
"just this one worker still writes" residue.

A handler that raises leaves cairnq to record the failure and retry per the
task's ``max_attempts`` — which replaces the ``post_process_failures``
blacklist table for everything except the one-shot cases basics owns.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np

from worker.codec import decode_vector
from worker.ladder import run_with_fallback

#: Registered heads. Guarding here rather than passing ``payload["scorer"]``
#: straight into the loader keeps an arbitrary string out of a filesystem path
#: — the payload crosses a process boundary, so it is input, not a constant.
_SILVA_SCORERS = frozenset({"silva", "silva_luna"})


async def handle_silva(payload: dict[str, Any]) -> dict[str, Any]:
    """Score stored SigLIP2 embeddings with one of the SILVA heads.

    Payload is ``{scorer, items: [{postId, embedding}]}`` where ``embedding`` is
    the base64 float32 of the vector already stored in ``post_vectors_siglip2``
    — the worker does not read it back itself. Returns
    ``{scores: [{postId, score}]}`` in the same order; TS writes the rows.

    The vectors travel with the payload rather than being re-read here because
    of §D1: an exception for "this worker may read the DB" is exactly the kind
    of per-worker rule the refactor exists to remove. ``SILVA_TASK_BATCH`` (64)
    is sized for that — see the TS side for the payload-size arithmetic.
    """
    scorer = payload["scorer"]
    if scorer not in _SILVA_SCORERS:
        msg = f"unknown scorer: {scorer!r}"
        raise ValueError(msg)

    items = payload["items"]
    if not items:
        return {"scores": []}

    # Imported here rather than at module scope so an empty batch — and the
    # connectivity check that submits one — costs nothing: torch and the head
    # weights are seconds and gigabytes of VRAM.
    from ai.silva_scorer import score_embeddings  # noqa: PLC0415

    # Stacked into one [N, 1152] array rather than handed over as a list of
    # arrays: that is the shape the head wants anyway, and it makes the width
    # check in decode_vector the only place a ragged payload can fail.
    embeddings = np.stack([decode_vector(item["embedding"]) for item in items])
    # ``to_thread`` rather than a straight call: cairnq runs handlers on its own
    # event loop, and that loop is also what renews this task's lease. A
    # multi-second forward blocking it would let the lease expire and the task
    # be handed to another worker while this one is still computing it.
    scores = await asyncio.to_thread(score_embeddings, embeddings, scorer)
    return {
        "scores": [
            {"postId": item["postId"], "score": float(score)}
            for item, score in zip(items, scores, strict=True)
        ],
    }


#: Root every payload path must live under. Set once by ``main.py``; a handler
#: refuses to touch anything outside it.
#:
#: The payload crosses a process boundary through a database, so a path in it is
#: *input* — the same reason ``server/images.py`` resolves inside ``target_dir``
#: before serving a file. Nothing today writes a hostile path, and that is
#: exactly when the check is cheap to add.
_ROOT: Path | None = None


def set_root(root: Path) -> None:
    global _ROOT  # noqa: PLW0603 — process-wide config, set once at startup
    _ROOT = root.resolve()


def _resolve_inside(raw: str) -> Path:
    path = Path(raw).resolve()
    if _ROOT is None:
        msg = "worker root not configured"
        raise RuntimeError(msg)
    if not path.is_relative_to(_ROOT):
        msg = f"path escapes the library root: {raw}"
        raise ValueError(msg)
    return path


async def handle_waifu(payload: dict[str, Any]) -> dict[str, Any]:
    """Score images with the CLIP-backed waifu scorer.

    Payload is ``{items: [{postId, path}]}`` — absolute paths, because the
    worker has no database to look them up in (§D1). Returns
    ``{scores: [...], failures: [...]}``; TS writes the scores and decides what
    a failure means (for this worker: a one-shot blacklist, matching the old
    ``blacklist_policy = "ladder"``).

    Files that vanished between the pending query and the batch are dropped
    here rather than failed — they are not bad data, they are gone, and the
    pending query will stop offering them once the row goes too.
    """
    items_in = payload["items"]
    if not items_in:
        return {"scores": [], "failures": []}

    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: defer the ML stack

    items: list[tuple[int, Path]] = []
    failures: list[dict[str, Any]] = []
    for item in items_in:
        try:
            path = _resolve_inside(item["path"])
        except ValueError as exc:
            failures.append({"postId": item["postId"], "error": str(exc)})
            continue
        if path.exists():
            items.append((item["postId"], path))

    # The loader itself touches disk and VRAM, so it goes off-loop too — see
    # the note in handle_silva about the lease.
    scorer = await asyncio.to_thread(get_waifu_scorer)
    successes, ladder_failures = await run_with_fallback(scorer, items, label="waifu")
    return {
        "scores": [{"postId": pid, "score": float(score)} for pid, score in successes],
        "failures": failures + [{"postId": pid, "error": err} for pid, err in ladder_failures],
    }
