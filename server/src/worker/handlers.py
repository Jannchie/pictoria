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

from typing import Any

import numpy as np

from worker.codec import decode_vector

#: Registered heads. Guarding here rather than passing ``payload["scorer"]``
#: straight into the loader keeps an arbitrary string out of a filesystem path
#: — the payload crosses a process boundary, so it is input, not a constant.
_SILVA_SCORERS = frozenset({"silva", "silva_luna"})


def handle_silva(payload: dict[str, Any]) -> dict[str, Any]:
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
    scores = score_embeddings(embeddings, scorer)
    return {
        "scores": [
            {"postId": item["postId"], "score": float(score)}
            for item, score in zip(items, scores, strict=True)
        ],
    }
