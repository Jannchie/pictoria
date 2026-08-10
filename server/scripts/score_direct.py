"""Score posts through the OLD in-process path, for the worker parity harness.

Reads ``{"scorer": ..., "postIds": [...]}`` on stdin and writes
``{"scores": [{"postId":, "score":}]}`` on stdout. It opens ``pictoria.sqlite``
directly and calls the scorer the way ``processors/scoring.py`` does — that is
the whole point: it is the *reference* implementation the cairnq path is checked
against.

``scorer`` is ``silva`` / ``silva_luna`` (embedding input) or ``waifu`` (image
input). Both read from the same database this script opens, which is exactly
what the new path is not allowed to do.

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


def _score_images(post_ids: list[int]) -> list[tuple[int, float]]:
    from ai.waifu_scorer import get_waifu_scorer  # noqa: PLC0415  # lazy: same

    conn = _connect()
    cur = conn.cursor()
    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT id, full_path FROM posts WHERE id IN ({placeholders})",
        post_ids,
    )
    paths = {pid: TARGET_DIR / rel for pid, rel in cur.fetchall()}
    conn.close()

    ordered = [pid for pid in post_ids if pid in paths and paths[pid].exists()]
    if not ordered:
        return []
    scores = get_waifu_scorer()([paths[pid] for pid in ordered])
    return list(zip(ordered, [float(s) for s in scores], strict=True))


def main() -> None:
    req = json.load(sys.stdin)
    scorer: str = req["scorer"]
    post_ids: list[int] = req["postIds"]

    pairs = _score_images(post_ids) if scorer == "waifu" else _score_embeddings(scorer, post_ids)
    json.dump({"scores": [{"postId": pid, "score": s} for pid, s in pairs]}, _RESULT_STREAM)


if __name__ == "__main__":
    main()
