"""Score posts through the OLD in-process path, for the worker parity harness.

Reads ``{"scorer": ..., "postIds": [...]}`` on stdin and writes
``{"scores": [{"postId":, "score":}]}`` on stdout. It opens ``pictoria.sqlite``
directly and calls ``score_embeddings`` the way ``processors/scoring.py`` does —
that is the whole point: it is the *reference* implementation the cairnq path is
checked against.

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

import sqlite_vec

from ai.silva_scorer import score_embeddings

DB_PATH = Path(__file__).resolve().parents[1] / "illustration" / "images" / ".pictoria" / "pictoria.sqlite"


def main() -> None:
    req = json.load(sys.stdin)
    scorer: str = req["scorer"]
    post_ids: list[int] = req["postIds"]

    conn = sqlite3.connect(DB_PATH)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    cur = conn.cursor()

    placeholders = ",".join("?" * len(post_ids))
    cur.execute(
        f"SELECT post_id, embedding FROM post_vectors_siglip2 WHERE post_id IN ({placeholders})",
        post_ids,
    )
    emb = {pid: list(struct.unpack(f"{len(b) // 4}f", b)) for pid, b in cur.fetchall()}
    conn.close()

    ordered = [pid for pid in post_ids if pid in emb]
    scores = score_embeddings([emb[pid] for pid in ordered], scorer) if ordered else []
    json.dump({"scores": [{"postId": pid, "score": s} for pid, s in zip(ordered, scores, strict=True)]}, sys.stdout)


if __name__ == "__main__":
    main()
