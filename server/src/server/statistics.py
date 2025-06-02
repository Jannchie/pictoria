from typing import ClassVar

import litestar
from litestar import Controller
from msgspec import Struct
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import PostWaifuScore


class WaifuScoreResult(Struct):
    bucket: str
    count: int


async def get_waifu_score_buckets(session: AsyncSession):
    # 分数在[bucket, bucket+1]，即左开右闭：(n-1, n]
    # 但0分包括，因此第一个桶是[0,1]
    bucket_case = case(
        *((PostWaifuScore.score <= i + 1, i) for i in range(9)),
        else_=9,
    )

    stmt = (
        select(
            bucket_case.label("bucket"),
            func.count().label("count"),
        )
        .group_by("bucket")
        .order_by("bucket")
    )

    results = (await session.execute(stmt)).all()
    bucket_counts = dict.fromkeys(range(10), 0)
    for bucket, count in results:
        bucket_counts[bucket] = count
    return [WaifuScoreResult(bucket=f"{bucket}~{bucket + 1}", count=count) for bucket, count in bucket_counts.items()]


class StatisticsController(Controller):
    path = "/statistics"
    tags: ClassVar[list[str]] = ["Statistics"]

    @litestar.get("/")
    async def get_waifu_scorer_statistics(self, session: AsyncSession) -> list[WaifuScoreResult]:
        """
        Get statistics about the waifu scorer.
        waifu score is between 0.0 and 10.0, devided into 10 buckets.
        Each bucket contains the number of posts that fall into that score range.
        """
        return await get_waifu_score_buckets(session)
