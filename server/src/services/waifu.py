"""Waifu scorer service — batched scoring for unscored posts.

Native DuckDB version: takes a PostRepo and processes posts in batches.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
from typing import TYPE_CHECKING

from ai.waifu_scorer import get_waifu_scorer
from db.entities import Post
from progress import get_progress
from server.utils import is_image

if TYPE_CHECKING:
    from db.repositories.posts import PostRepo


async def waifu_score_all_posts(posts: PostRepo) -> None:
    """Score all posts that don't yet have a waifu score."""
    batch_size = 32
    scorer = get_waifu_scorer()

    def _list_unscored() -> list[tuple[int, str, str, str]]:
        posts.cur.execute(
            """
            SELECT p.id, p.file_path, p.file_name, p.extension
            FROM posts p
            LEFT JOIN post_waifu_scores pws ON pws.post_id = p.id
            WHERE pws.post_id IS NULL
            ORDER BY p.id
            """,
        )
        return list(posts.cur.fetchall())

    pending = await asyncio.to_thread(_list_unscored)
    if not pending:
        return

    with get_progress() as progress:
        task = progress.add_task("Waifu Scorer", total=len(pending))
        for i in range(0, len(pending), batch_size):
            batch = pending[i:i + batch_size]
            try:
                # Filter to actual image files
                _candidates = []
                _now = _dt.datetime.now(tz=_dt.UTC)
                for pid, fp, fn, ext in batch:
                    p = Post(
                        id=pid, file_path=fp, file_name=fn, extension=ext,
                        full_path=f"{fp}/{fn}.{ext}",
                        width=0, height=0, score=0, rating=0,
                        description="", meta="", sha256="", size=0, source="",
                        caption="", created_at=_now,
                        updated_at=_now,
                    )
                    if is_image(p.absolute_path):
                        _candidates.append((pid, p.absolute_path))
                if not _candidates:
                    progress.update(task, advance=len(batch))
                    continue

                images = [path for _, path in _candidates]
                results = await asyncio.to_thread(scorer, images)
                for (pid, _), result in zip(_candidates, results, strict=True):
                    await posts.upsert_waifu_score(pid, float(result))
                progress.update(task, advance=len(batch))
            except Exception as exc:
                progress.console.log(f"Error processing batch: {exc!s}")
                continue
