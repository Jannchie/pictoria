"""Score every post that doesn't yet have a waifu score.

Run from server/ dir:
    uv run python scripts/waifu_score_all.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SERVER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER_ROOT / "src"))

import shared

shared.target_dir = SERVER_ROOT / "illustration" / "images"
shared.pictoria_dir = shared.target_dir / ".pictoria"
shared.thumbnails_dir = shared.pictoria_dir / "thumbnails"

from db import DB
from db.repositories.posts import PostRepo
from services.waifu import waifu_score_all_posts

DB_PATH = shared.pictoria_dir / "pictoria.duckdb"


async def main() -> int:
    if not DB_PATH.exists():
        print(f"ERROR: DB not found at {DB_PATH}")
        return 1

    db = DB(DB_PATH)
    posts = PostRepo(db.cursor())
    try:
        await waifu_score_all_posts(posts)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
