"""Export annotation events to parquet for silva training.

Absolute events are aggregated latest-wins per (post_id, dimension) and joined with
SigLIP2 embeddings; pairwise events are exported one row per judgement (skip excluded).

    uv run python scripts/export_annotations.py --out-dir ../data/annotations          # both kinds
    uv run python scripts/export_annotations.py --kind absolute --out-dir ../data
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

SERVER_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from db import DB, run_migrations

MIGRATIONS_DIR = SERVER_ROOT / "migrations"
EMBEDDING_TABLE = "post_vectors_siglip2"


def _embedding_for(cur, post_id: int) -> list[float] | None:
    cur.execute(f"SELECT embedding FROM {EMBEDDING_TABLE} WHERE post_id = ?", [post_id])
    row = cur.fetchone()
    if row is None:
        return None
    return np.frombuffer(row[0], dtype=np.float32).tolist()


def export_absolute(cur, out_path: pathlib.Path) -> int:
    """Latest-wins per (post_id, dimension), join embedding. Returns row count."""
    cur.execute(
        """
        SELECT a.post_id, a.dimension, a.scale, a.value, a.rubric_version,
               (SELECT COUNT(*) FROM absolute_annotations c
                 WHERE c.post_id = a.post_id AND c.dimension = a.dimension) AS n_events
        FROM absolute_annotations a
        WHERE a.id = (SELECT MAX(b.id) FROM absolute_annotations b
                       WHERE b.post_id = a.post_id AND b.dimension = a.dimension)
        ORDER BY a.post_id, a.dimension
        """,
    )
    rows = cur.fetchall()
    records = {"embedding": [], "dimension": [], "scale": [], "value": [], "n_events": [], "rubric_version": [], "post_id": []}
    skipped = 0
    for post_id, dimension, scale, value, rubric_version, n_events in rows:
        emb = _embedding_for(cur, post_id)
        if emb is None:
            skipped += 1
            continue
        records["embedding"].append(emb)
        records["dimension"].append(dimension)
        records["scale"].append(scale)
        records["value"].append(value)
        records["n_events"].append(n_events)
        records["rubric_version"].append(rubric_version)
        records["post_id"].append(post_id)
    if skipped:
        print(f"[export_absolute] skipped {skipped} rows with no embedding")
    table = pa.table(records)
    pq.write_table(table, out_path)
    return table.num_rows


def export_pairwise(cur, out_path: pathlib.Path) -> int:
    """One row per non-skip pairwise judgement, embeddings for both sides."""
    cur.execute(
        """
        SELECT post_a, post_b, dimension, winner, rubric_version
        FROM pairwise_annotations
        WHERE winner != 'skip'
        ORDER BY id
        """,
    )
    rows = cur.fetchall()
    records = {"embedding_a": [], "embedding_b": [], "dimension": [], "winner": [], "rubric_version": [], "post_id_a": [], "post_id_b": []}
    skipped = 0
    for post_a, post_b, dimension, winner, rubric_version in rows:
        ea, eb = _embedding_for(cur, post_a), _embedding_for(cur, post_b)
        if ea is None or eb is None:
            skipped += 1
            continue
        records["embedding_a"].append(ea)
        records["embedding_b"].append(eb)
        records["dimension"].append(dimension)
        records["winner"].append(winner)
        records["rubric_version"].append(rubric_version)
        records["post_id_a"].append(post_a)
        records["post_id_b"].append(post_b)
    if skipped:
        print(f"[export_pairwise] skipped {skipped} rows with missing embeddings")
    table = pa.table(records)
    pq.write_table(table, out_path)
    return table.num_rows


def main() -> None:
    ap = argparse.ArgumentParser(description="Export annotation events to parquet.")
    ap.add_argument("--db", default=os.environ.get("DB_PATH", r"E:/pictoria/server/illustration/images/.pictoria/pictoria.sqlite"))
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--kind", choices=["absolute", "pairwise", "both"], default="both")
    args = ap.parse_args()

    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    db = DB(pathlib.Path(args.db))
    try:
        run_migrations(db.raw, MIGRATIONS_DIR)
        cur = db.cursor()
        if args.kind in ("absolute", "both"):
            n = export_absolute(cur, out_dir / "annotations_absolute.parquet")
            print(f"absolute: {n} rows -> {out_dir / 'annotations_absolute.parquet'}")
        if args.kind in ("pairwise", "both"):
            n = export_pairwise(cur, out_dir / "annotations_pairwise.parquet")
            print(f"pairwise: {n} rows -> {out_dir / 'annotations_pairwise.parquet'}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
