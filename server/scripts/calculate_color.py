"""Compute and persist dominant Lab color for posts that don't have one yet.

Run from server/ dir:
    uv run python scripts/calculate_color.py

Reads from the DuckDB at ``illustration/images/.pictoria/pictoria.duckdb``.
Workers read image bytes + compute dominant_color in parallel; the main
thread serializes all UPDATEs (DuckDB writes can't be concurrent).
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import duckdb
import numpy as np
from rich.progress import track
from skimage import color

from tools.colors import get_dominant_color

DEFAULT_DB = SERVER_ROOT / "illustration" / "images" / ".pictoria" / "pictoria.duckdb"
TARGET_DIR = SERVER_ROOT / "illustration" / "images"
MAX_WORKERS = 8


def _compute_lab(post_id: int, full_path: str) -> tuple[int, list[float] | None]:
    abs_path = TARGET_DIR / full_path
    if not abs_path.is_file():
        return post_id, None
    try:
        rgb = get_dominant_color(abs_path)
        rgb_norm = np.array(rgb, dtype=np.float64) / 255.0
        lab = color.rgb2lab(rgb_norm.reshape(1, 1, 3)).reshape(3)
        return post_id, [float(x) for x in lab]
    except Exception as exc:
        print(f"  post {post_id}: {exc!r}")
        return post_id, None


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.exists():
        print(f"ERROR: DB not found at {db_path}")
        return 1

    conn = duckdb.connect(str(db_path))
    rows = conn.execute(
        "SELECT id, full_path FROM posts WHERE dominant_color IS NULL",
    ).fetchall()
    print(f"posts missing dominant_color: {len(rows)}")
    if not rows:
        conn.close()
        return 0

    pending: dict[int, list[float]] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = [ex.submit(_compute_lab, pid, fp) for pid, fp in rows]
        for fut in track(as_completed(futures), total=len(futures), description="Computing dominant_color"):
            pid, lab = fut.result()
            if lab is not None:
                pending[pid] = lab

    print(f"writing {len(pending)} updates...")
    for pid, lab in pending.items():
        conn.execute(
            "UPDATE posts SET dominant_color = ?, updated_at = now() WHERE id = ?",
            [lab, pid],
        )
    conn.close()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
