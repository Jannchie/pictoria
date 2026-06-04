"""Backfill SILVA aesthetic scores across the whole library.

Standalone CLI that runs the same ``run_silva_worker`` the server uses during
metadata sync, but without booting the HTTP app. The server now runs this
worker on every sync, so an existing library backfills automatically on the
next boot; reach for this script only to run the backfill on its own — e.g.
against a DB without starting the server.

It reuses the worker's pending query (posts with no ``silva`` row in
``post_aesthetic_scores`` and not already on the ``aesthetic:silva`` failure
blacklist), batch/fallback scoring, and the shared rich progress bar. Re-runs
are safe: already-scored posts are skipped, so it is resumable.

Run from ``server/``:

    uv run python scripts/backfill_silva_scores.py --target_dir ./illustration/images

Honours ``DB_PATH`` (same as the server) when set; otherwise uses
``<target_dir>/.pictoria/pictoria.sqlite``.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

from dotenv import load_dotenv

import shared
from bootstrap import initialize
from db import DB, run_migrations
from db.repositories.posts import PostRepo
from db.repositories.vectors import VectorRepo
from processors import run_silva_worker
from progress import get_progress
from shared import logger

MIGRATIONS_DIR = SERVER_ROOT / "migrations"


async def _run(db: DB) -> None:
    # A dedicated connection (its own cursor/row state) mirrors how
    # run_all_backfill hands each worker its own connection.
    conn = db.new_connection()
    try:
        with get_progress() as progress:
            await run_silva_worker(
                PostRepo(conn.cursor()),
                VectorRepo(conn.cursor(), table="post_vectors_siglip2", dim=1152),
                progress=progress,
            )
    finally:
        with contextlib.suppress(Exception):
            conn.close()


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Backfill SILVA aesthetic scores for every unscored post.",
    )
    parser.add_argument(
        "--target_dir",
        type=str,
        default=str(SERVER_ROOT / "illustration" / "images"),
        help="Image library root (default: server/illustration/images).",
    )
    args = parser.parse_args()

    initialize(target_dir=args.target_dir)

    db_path_env = os.environ.get("DB_PATH")
    db_path = Path(db_path_env) if db_path_env else (shared.pictoria_dir / "pictoria.sqlite")
    if not db_path.exists():
        logger.error(f"DB not found at {db_path}")
        return 1

    logger.info(f"Opening SQLite at {db_path}")
    db = DB(db_path)
    # Idempotent — guarantees post_aesthetic_scores exists on an old DB.
    run_migrations(db.cursor(), MIGRATIONS_DIR)

    asyncio.run(_run(db))
    logger.info("SILVA backfill complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
