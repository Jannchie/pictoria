"""ScoreRepo — async Repository over the post score tables.

Owns ``post_waifu_scores`` (single hard-coded scorer) and
``post_aesthetic_scores`` (generic per-(post, scorer) table). The public
``async`` methods are used by AI/command paths; the synchronous
``fetch_*_by_ids`` helpers are called from inside the read/query layer's
``asyncio.to_thread`` block to batch-assemble read models.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3


class ScoreRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    # ─── Waifu score ─────────────────────────────────────────────────
    async def get_waifu_score(self, post_id: int) -> float | None:
        def _impl() -> float | None:
            self.cur.execute(
                "SELECT score FROM post_waifu_scores WHERE post_id = ?",
                [post_id],
            )
            row = self.cur.fetchone()
            return float(row[0]) if row else None

        return await asyncio.to_thread(_impl)

    async def upsert_waifu_score(self, post_id: int, score: float) -> None:
        def _impl() -> None:
            self.cur.execute(
                "INSERT INTO post_waifu_scores(post_id, score) VALUES (?, ?) "
                "ON CONFLICT (post_id) DO UPDATE SET score = excluded.score",
                [post_id, score],
            )

        await asyncio.to_thread(_impl)

    # ─── Aesthetic scores (generic per-scorer table) ─────────────────
    async def get_aesthetic_scores(self, post_id: int) -> list[dict]:
        """Return ``[{"scorer": str, "score": float}, ...]`` for a post."""

        def _impl() -> list[dict]:
            self.cur.execute(
                "SELECT scorer, score FROM post_aesthetic_scores "
                "WHERE post_id = ? ORDER BY scorer",
                [post_id],
            )
            return [{"scorer": r[0], "score": float(r[1])} for r in self.cur.fetchall()]

        return await asyncio.to_thread(_impl)

    async def get_aesthetic_score(self, post_id: int, scorer: str) -> float | None:
        def _impl() -> float | None:
            self.cur.execute(
                "SELECT score FROM post_aesthetic_scores "
                "WHERE post_id = ? AND scorer = ?",
                [post_id, scorer],
            )
            row = self.cur.fetchone()
            return float(row[0]) if row else None

        return await asyncio.to_thread(_impl)

    async def upsert_aesthetic_score(self, post_id: int, scorer: str, score: float) -> None:
        def _impl() -> None:
            self.cur.execute(
                "INSERT INTO post_aesthetic_scores(post_id, scorer, score) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT (post_id, scorer) DO UPDATE SET score = excluded.score",
                [post_id, scorer, score],
            )

        await asyncio.to_thread(_impl)

    # ─── Batch fetch (sync; called inside the query layer's worker thread) ──
    def fetch_waifu_by_ids(self, ids: list[int]) -> dict[int, dict]:
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        self.cur.execute(
            f"SELECT post_id, score FROM post_waifu_scores "  # noqa: S608
            f"WHERE post_id IN ({placeholders})",
            ids,
        )
        return {pid: {"score": score} for pid, score in self.cur.fetchall()}

    def fetch_aesthetic_by_ids(self, ids: list[int]) -> dict[int, list[dict]]:
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        self.cur.execute(
            f"SELECT post_id, scorer, score FROM post_aesthetic_scores "  # noqa: S608
            f"WHERE post_id IN ({placeholders}) ORDER BY post_id, scorer",
            ids,
        )
        result: dict[int, list[dict]] = {}
        for pid, scorer, score in self.cur.fetchall():
            result.setdefault(pid, []).append({"scorer": scorer, "score": float(score)})
        return result
