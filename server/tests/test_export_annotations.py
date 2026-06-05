"""Tests for the annotation export CLI (latest-wins aggregation + embedding join)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pyarrow.parquet as pq
import sqlite_vec

from db.repositories.annotations import AnnotationRepo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from export_annotations import export_absolute, export_pairwise

if TYPE_CHECKING:
    from db.connection import DB

DIM = 1152


def _seed_embeddings(db: DB, post_ids: list[int]) -> None:
    cur = db.cursor()
    for pid in post_ids:
        blob = sqlite_vec.serialize_float32([0.01 * pid] * DIM)
        cur.execute(
            "INSERT INTO post_vectors_siglip2 (post_id, embedding) VALUES (?, ?)",
            [pid, blob],
        )


async def test_export_absolute_latest_wins(db: DB, tmp_path: Path) -> None:
    _seed_embeddings(db, [1, 2])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_absolute(post_id=1, dimension="color", scale=2, value=1, rubric_version="color-v1", session_id="s1")
    await repo.insert_absolute(post_id=1, dimension="color", scale=2, value=2, rubric_version="color-v1", session_id="s2")  # 最新优先应取这条
    await repo.insert_absolute(post_id=2, dimension="finish", scale=2, value=1, rubric_version="finish-v1", session_id="s2")

    out = tmp_path / "absolute.parquet"
    n = export_absolute(db.cursor(), out)
    assert n == 2  # (post1, color) 聚合成一行 + (post2, finish)

    rows = {(r["post_id"], r["dimension"]): r for r in pq.read_table(out).to_pylist()}
    assert rows[(1, "color")]["value"] == 2
    assert rows[(1, "color")]["n_events"] == 2
    assert len(rows[(1, "color")]["embedding"]) == DIM


async def test_export_pairwise_skips_skip(db: DB, tmp_path: Path) -> None:
    _seed_embeddings(db, [1, 2, 3])
    repo = AnnotationRepo(db.cursor())
    await repo.insert_pairwise(post_a=1, post_b=2, dimension="color", winner="a", rubric_version="color-v1", session_id="s1")
    await repo.insert_pairwise(post_a=2, post_b=3, dimension="color", winner="skip", rubric_version="color-v1", session_id="s1")

    out = tmp_path / "pairwise.parquet"
    n = export_pairwise(db.cursor(), out)
    assert n == 1  # skip 不导出

    rows = pq.read_table(out).to_pylist()
    assert rows[0]["winner"] == "a"
    assert len(rows[0]["embedding_a"]) == DIM
    assert len(rows[0]["embedding_b"]) == DIM
