from typing import ClassVar

import litestar
from litestar import Controller
from msgspec import Struct

from db.repositories.scores import ScoreRepo


class WaifuScoreResult(Struct):
    bucket: str
    count: int


class StatisticsController(Controller):
    path = "/statistics"
    tags: ClassVar[list[str]] = ["Statistics"]  # type: ignore

    @litestar.get("/")
    async def get_waifu_scorer_statistics(self, scores: ScoreRepo) -> list[WaifuScoreResult]:
        """Histogram of waifu scores in 10 integer-wide buckets ``[0,1), …, [9,10]``."""
        distribution = await scores.waifu_score_distribution()
        return [
            WaifuScoreResult(bucket=f"{b}~{b + 1}", count=c)
            for b, c in distribution
        ]
