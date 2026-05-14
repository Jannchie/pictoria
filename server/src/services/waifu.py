"""Waifu scorer service — thin wrapper around the ``processors`` worker.

Kept as a separate module so the ``/cmd/waifu-scorer`` route and any other
on-demand callers don't need to know about ``processors`` internals.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from processors import run_waifu_worker
from progress import get_progress

if TYPE_CHECKING:
    from db.repositories.posts import PostRepo


async def waifu_score_all_posts(posts: PostRepo) -> None:
    """Score every post that doesn't yet have a waifu score."""
    with get_progress() as progress:
        await run_waifu_worker(posts, progress=progress)
