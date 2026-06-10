"""Annotation endpoints: submit append-only events, read per-post history.

Requests are msgspec Structs (snake_case, like ``PostFilter``); responses are
``DTOBaseModel`` (camelCase). Submitting with ``queue_id``/``queue_position``
marks the queue item done in the same request.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003  # Pydantic needs runtime types
from typing import ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import ValidationException
from msgspec import Struct

from db.repositories.annotation_queues import AnnotationQueueRepo  # noqa: TC001  # DI needs runtime types
from db.repositories.annotations import AnnotationRepo  # noqa: TC001  # DI needs runtime types
from scheme import DTOBaseModel
from server.annotation_queues import VALID_PAIRWISE_STRATEGIES, QueueItemPostPublic, post_from_row

VALID_DIMENSIONS = {"color", "finish", "composition", "overall"}
VALID_FLAGS = {"love", "hate", "none"}
VALID_WINNERS = {"a", "b", "tie", "skip"}
VALID_SCALES = {2, 3, 5}


class AbsoluteEventIn(Struct):
    post_id: int
    dimension: str
    scale: int
    value: int
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class AbsoluteBatchIn(Struct):
    events: list[AbsoluteEventIn]
    queue_id: int | None = None
    queue_position: int | None = None


class PairwiseEventIn(Struct):
    post_a: int
    post_b: int
    dimension: str
    winner: str
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None
    queue_id: int | None = None
    queue_position: int | None = None


class ContentFlagIn(Struct):
    post_id: int
    flag: str
    session_id: str


class InsertedPublic(DTOBaseModel):
    inserted: int


class AbsoluteAnnotationPublic(DTOBaseModel):
    id: int
    created_at: datetime
    post_id: int
    dimension: str
    scale: int
    value: int
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class PairwiseAnnotationPublic(DTOBaseModel):
    id: int
    created_at: datetime
    post_a: int
    post_b: int
    dimension: str
    winner: str
    rubric_version: str
    session_id: str
    elapsed_ms: int | None = None


class PostAnnotationsPublic(DTOBaseModel):
    absolute: list[AbsoluteAnnotationPublic]
    pairwise: list[PairwiseAnnotationPublic]
    content_flag: str | None = None


class SampledPairPublic(DTOBaseModel):
    post_a: QueueItemPostPublic
    post_b: QueueItemPostPublic


class PairwiseCountPublic(DTOBaseModel):
    total: int  # decisive + tie (judged pairs; skips excluded)
    decisive: int  # a/b verdicts
    tie: int
    skip: int


def _validate_absolute(e: AbsoluteEventIn) -> None:
    if e.dimension not in VALID_DIMENSIONS:
        msg = f"invalid dimension: {e.dimension!r}"
        raise ValidationException(msg)
    if e.scale not in VALID_SCALES:
        msg = f"invalid scale: {e.scale}"
        raise ValidationException(msg)
    if not 1 <= e.value <= e.scale:
        msg = f"value {e.value} out of range for scale {e.scale}"
        raise ValidationException(msg)


class AnnotationController(Controller):
    path = "/annotations"
    tags: ClassVar[list[str]] = ["Annotations"]

    @litestar.post(
        "/absolute",
        status_code=201,
        description="Submit a batch of absolute annotation events (one image, several dimensions). Optionally marks a queue item done.",
    )
    async def submit_absolute(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        data: AbsoluteBatchIn,
    ) -> InsertedPublic:
        for e in data.events:
            _validate_absolute(e)
        for e in data.events:
            await annotations.insert_absolute(
                post_id=e.post_id,
                dimension=e.dimension,
                scale=e.scale,
                value=e.value,
                rubric_version=e.rubric_version,
                session_id=e.session_id,
                elapsed_ms=e.elapsed_ms,
            )
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind="absolute", position=data.queue_position)
        return InsertedPublic(inserted=len(data.events))

    @litestar.post(
        "/pairwise",
        status_code=201,
        description="Submit one pairwise judgement. Optionally marks a queue item done.",
    )
    async def submit_pairwise(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        data: PairwiseEventIn,
    ) -> InsertedPublic:
        if data.dimension not in VALID_DIMENSIONS:
            msg = f"invalid dimension: {data.dimension!r}"
            raise ValidationException(msg)
        if data.winner not in VALID_WINNERS:
            msg = f"invalid winner: {data.winner!r}"
            raise ValidationException(msg)
        await annotations.insert_pairwise(
            post_a=data.post_a,
            post_b=data.post_b,
            dimension=data.dimension,
            winner=data.winner,
            rubric_version=data.rubric_version,
            session_id=data.session_id,
            elapsed_ms=data.elapsed_ms,
        )
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind="pairwise", position=data.queue_position)
        return InsertedPublic(inserted=1)

    @litestar.post(
        "/content-flag",
        status_code=201,
        description="Record a content taste flag for a post ('none' = retract).",
    )
    async def submit_content_flag(self, annotations: AnnotationRepo, data: ContentFlagIn) -> InsertedPublic:
        if data.flag not in VALID_FLAGS:
            msg = f"invalid flag: {data.flag!r}"
            raise ValidationException(msg)
        await annotations.insert_content_flag(post_id=data.post_id, flag=data.flag, session_id=data.session_id)
        return InsertedPublic(inserted=1)

    @litestar.get(
        "/sample-absolute",
        status_code=200,
        description="Queue-less streaming: sample candidate posts for absolute annotation. Posts already annotated in any requested dimension are excluded.",
    )
    async def sample_absolute(
        self,
        annotation_queues: AnnotationQueueRepo,
        dimensions: list[str],
        strategy: str = "random",
        limit: int = 10,
    ) -> list[QueueItemPostPublic]:
        if not dimensions or any(d not in VALID_DIMENSIONS for d in dimensions):
            msg = f"invalid dimensions: {dimensions!r}"
            raise ValidationException(msg)
        if strategy not in {"random", "stratified"}:
            msg = f"invalid strategy: {strategy!r}"
            raise ValidationException(msg)
        items = await annotation_queues.sample_absolute_items(count=limit, strategy=strategy, dimensions=dimensions)
        return [post_from_row(r) for r in items]

    @litestar.get(
        "/sample-pairwise",
        status_code=200,
        description="Queue-less streaming: sample disjoint pairs for pairwise annotation ('random', or 'similar' = content-similar + old-score band).",
    )
    async def sample_pairwise(
        self,
        annotation_queues: AnnotationQueueRepo,
        limit: int = 10,
        strategy: str = "random",
    ) -> list[SampledPairPublic]:
        if strategy not in VALID_PAIRWISE_STRATEGIES:
            msg = f"invalid strategy: {strategy!r}"
            raise ValidationException(msg)
        items = await annotation_queues.sample_pairwise_items(count=limit, strategy=strategy)
        return [SampledPairPublic(post_a=post_from_row(r, "a_"), post_b=post_from_row(r, "b_")) for r in items]

    @litestar.get(
        "/pairwise/count",
        status_code=200,
        description="Cumulative pairwise judgement counts for a dimension (total = decisive + tie, skips excluded).",
    )
    async def count_pairwise(self, annotations: AnnotationRepo, dimension: str = "overall") -> PairwiseCountPublic:
        if dimension not in VALID_DIMENSIONS:
            msg = f"invalid dimension: {dimension!r}"
            raise ValidationException(msg)
        c = await annotations.count_pairwise(dimension)
        return PairwiseCountPublic(total=c["total"], decisive=c["decisive"], tie=c["tie"], skip=c["skip"])

    @litestar.get("/post/{post_id:int}", status_code=200, description="Full annotation history for a post.")
    async def post_history(self, annotations: AnnotationRepo, post_id: int) -> PostAnnotationsPublic:
        absolute = await annotations.list_absolute_for_post(post_id)
        pairwise = await annotations.list_pairwise_for_post(post_id)
        flag = await annotations.latest_content_flag(post_id)
        return PostAnnotationsPublic(
            absolute=[AbsoluteAnnotationPublic.model_validate(a) for a in absolute],
            pairwise=[PairwiseAnnotationPublic.model_validate(p) for p in pairwise],
            content_flag=None if flag is None or flag.flag == "none" else flag.flag,
        )
