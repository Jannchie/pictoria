"""Run a worker through the OLD in-process path, for the parity harness.

Reads ``{"scorer": ..., "postIds": [...]}`` on stdin and writes that worker's
result on stdout — ``{"scores": [...]}`` for the scorers, ``{"results": [...]}``
for the tagger. It opens ``pictoria.sqlite``
directly and calls the scorer the way ``processors/scoring.py`` does — that is
the whole point: it is the *reference* implementation the cairnq path is checked
against.

``scorer`` is ``silva`` / ``silva_luna`` (embedding input), ``waifu`` (image
input) or ``tagger``. All of them read from the same database this script opens,
which is exactly what the new path is not allowed to do.

Nothing else may import this. It exists to be the thing the new path has to
match, and it dies with the old path in Phase 7.
"""

from __future__ import annotations

import json
import sqlite3
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# The waifu scorer's loader logs to stdout through rich, which would land in the
# middle of the JSON this script exists to emit. Hand the rest of the process a
# stdout that is really stderr, and keep the real one to write the result on.
_RESULT_STREAM = sys.stdout
sys.stdout = sys.stderr

import sqlite_vec

SERVER_ROOT = Path(__file__).resolve().parents[1]
TARGET_DIR = SERVER_ROOT / "illustration" / "images"
DB_PATH = TARGET_DIR / ".pictoria" / "pictoria.sqlite"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def _score_embeddings(scorer: str, post_ids: list[int]) -> list[tuple[int, float]]:
    from ai.silva_scorer import score_embeddings  # noqa: PLC0415  # lazy: the ML stack is seconds and GBs

    conn = _connect()
    cur = conn.cursor()
    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT post_id, embedding FROM post_vectors_siglip2 WHERE post_id IN ({placeholders})",
        post_ids,
    )
    emb = {pid: list(struct.unpack(f"{len(b) // 4}f", b)) for pid, b in cur.fetchall()}
    conn.close()

    ordered = [pid for pid in post_ids if pid in emb]
    if not ordered:
        return []
    scores = score_embeddings([emb[pid] for pid in ordered], scorer)
    return list(zip(ordered, scores, strict=True))


def _paths_for(post_ids: list[int]) -> dict[int, Path]:
    conn = _connect()
    cur = conn.cursor()
    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT id, full_path FROM posts WHERE id IN ({placeholders})",
        post_ids,
    )
    paths = {pid: TARGET_DIR / rel for pid, rel in cur.fetchall()}
    conn.close()
    return paths


def _score_images(post_ids: list[int]) -> list[tuple[int, float]]:
    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: same

    paths = _paths_for(post_ids)
    ordered = [pid for pid in post_ids if pid in paths and paths[pid].exists()]
    if not ordered:
        return []
    scores = get_waifu_scorer()([paths[pid] for pid in ordered])
    return list(zip(ordered, [float(s) for s in scores], strict=True))


def _tag_images(post_ids: list[int]) -> list[dict[str, object]]:
    from services.wd_tagging import get_tagger  # noqa: PLC0415  # lazy: same

    paths = _paths_for(post_ids)
    ordered = [pid for pid in post_ids if pid in paths and paths[pid].exists()]
    if not ordered:
        return []
    results = get_tagger().tag([paths[pid] for pid in ordered])
    if not isinstance(results, list):
        results = [results]
    return [
        {
            "postId": pid,
            "generalTags": list(r.general_tags),
            "characterTags": list(r.character_tags),
            "rating": r.rating or "",
        }
        for pid, r in zip(ordered, results, strict=True)
    ]


def _embed_images(post_ids: list[int]) -> list[dict[str, object]]:
    import base64  # noqa: PLC0415

    import numpy as np  # noqa: PLC0415

    from ai.siglip_embed import calculate_image_features_batch  # noqa: PLC0415  # lazy: same

    paths = _paths_for(post_ids)
    ordered = [pid for pid in post_ids if pid in paths and paths[pid].exists()]
    if not ordered:
        return []
    feats = calculate_image_features_batch([paths[pid] for pid in ordered]).cpu().numpy().astype(np.float32)
    return [
        {"postId": pid, "embedding": base64.b64encode(feats[i].tobytes()).decode()}
        for i, pid in enumerate(ordered)
    ]


def _dedup(post_ids: list[int], threshold: float, chunk_size: int) -> dict[str, object]:
    """The OLD dedup path over a subset: load vectors from the DB, matmul, greedy.

    Deliberately calls ``services.dedup`` rather than re-deriving it — the point
    of a reference implementation is that it *is* the code being replaced. The
    greedy loop below is copied from ``rebuild_groups``; the rest of that
    function is DB writes, which the new path does in TS.
    """
    import numpy as np  # noqa: PLC0415

    from services.dedup import _find_near_pairs  # noqa: PLC0415  # the thing under test

    conn = _connect()
    cur = conn.cursor()
    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT post_id, embedding FROM post_vectors_siglip2 WHERE post_id IN ({placeholders}) ORDER BY post_id ASC",
        post_ids,
    )
    rows = cur.fetchall()
    conn.close()

    ids = [int(pid) for pid, _ in rows]
    matrix = np.vstack([np.frombuffer(bytes(b), dtype=np.float32) for _, b in rows])
    adjacency = _find_near_pairs(matrix, threshold, chunk_size)

    claimed: dict[int, int] = {}
    for idx in range(len(ids)):
        if idx in claimed:
            continue
        for j in adjacency.get(idx, ()):
            if j in claimed:
                continue
            claimed[j] = idx

    return {
        "ids": ids,
        "pairs": sorted([i, j] for i, js in adjacency.items() for j in js),
        "assignments": sorted([ids[m], ids[c]] for m, c in claimed.items()),
    }


def _basics(post_ids: list[int]) -> list[dict[str, object]]:
    """The OLD basics path over a subset, with every field forced to recompute.

    Every post in the library already has its basics, so a faithful
    ``_compute_basics_for`` would short-circuit and compute nothing. The Post
    entities below are therefore built with the three "missing" markers
    (``sha256=''``, ``arthash=''``, ``dominant_color=None``) so the reference
    actually runs — the same trick the TS side uses by sending
    ``has*: false``.
    """
    import bootstrap  # noqa: PLC0415

    bootstrap.initialize(TARGET_DIR)

    from db.entities import POST_COLUMNS, Post  # noqa: PLC0415
    from processors.basics import _compute_basics_for  # noqa: PLC0415

    conn = _connect()
    cur = conn.cursor()
    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT {POST_COLUMNS} FROM posts WHERE id IN ({placeholders}) ORDER BY id",
        post_ids,
    )
    columns = [d[0] for d in cur.description]
    rows = [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]
    conn.close()

    out = []
    for row in rows:
        post = Post.model_validate({**row, "sha256": "", "arthash": "", "dominant_color": None})
        pid = post.id
        b = _compute_basics_for(post, post.absolute_path)
        if b is None:
            continue
        out.append(
            {
                "postId": pid,
                "sha256": b["sha256"],
                "size": b["size"],
                "arthash": b["arthash"],
                "width": b["width"],
                "height": b["height"],
                "colors": list(b["colors"]),
                "dominantLab": None if b["dominant_lab"] is None else [float(v) for v in b["dominant_lab"]],
                "colorError": b["color_error"],
            },
        )
    return out


def main() -> None:
    req = json.load(sys.stdin)
    scorer: str = req["scorer"]
    post_ids: list[int] = req["postIds"]

    if scorer == "tagger":
        json.dump({"results": _tag_images(post_ids)}, _RESULT_STREAM)
        return

    if scorer == "embedding":
        json.dump({"embeddings": _embed_images(post_ids)}, _RESULT_STREAM)
        return

    if scorer == "basics":
        json.dump({"rows": _basics(post_ids)}, _RESULT_STREAM)
        return

    if scorer == "dedup":
        json.dump(
            _dedup(post_ids, req.get("threshold", 0.01), req.get("chunkSize", 1024)),
            _RESULT_STREAM,
        )
        return

    pairs = _score_images(post_ids) if scorer == "waifu" else _score_embeddings(scorer, post_ids)
    json.dump({"scores": [{"postId": pid, "score": s} for pid, s in pairs]}, _RESULT_STREAM)


if __name__ == "__main__":
    main()
