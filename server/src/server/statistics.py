import asyncio
from typing import ClassVar

import litestar
from litestar import Controller
from msgspec import Struct

from db.repositories.posts import PostRepo


class WaifuScoreResult(Struct):
    bucket: str
    count: int


class StatisticsController(Controller):
    path = "/statistics"
    tags: ClassVar[list[str]] = ["Statistics"]  # type: ignore

    @litestar.get("/")
    async def get_waifu_scorer_statistics(self, posts: PostRepo) -> list[WaifuScoreResult]:
        """
        Get statistics about the waifu scorer.
        waifu score is between 0.0 and 10.0, divided into 10 buckets.
        Each bucket contains the number of posts that fall into that score range.
        """
        def _impl() -> list[WaifuScoreResult]:
            # 0~1, 1~2, ..., 9~10 (左闭右开, 但最后一个桶包含 10)
            posts.cur.execute(
                """
                SELECT
                    CASE
                        WHEN score < 1 THEN 0
                        WHEN score < 2 THEN 1
                        WHEN score < 3 THEN 2
                        WHEN score < 4 THEN 3
                        WHEN score < 5 THEN 4
                        WHEN score < 6 THEN 5
                        WHEN score < 7 THEN 6
                        WHEN score < 8 THEN 7
                        WHEN score < 9 THEN 8
                        ELSE 9
                    END AS bucket,
                    count(*) AS count
                FROM post_waifu_scores
                GROUP BY bucket
                ORDER BY bucket
                """,
            )
            counts = dict.fromkeys(range(10), 0)
            for bucket, count in posts.cur.fetchall():
                counts[bucket] = count
            return [
                WaifuScoreResult(bucket=f"{b}~{b + 1}", count=c)
                for b, c in counts.items()
            ]

        return await asyncio.to_thread(_impl)
