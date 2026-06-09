"""Annotation queue endpoints: create / auto-generate queues, serve next items.

Sampling is self-contained (see ``AnnotationQueueRepo``): ``generate-*`` builds
queues from data pictoria already owns — random, old-score-stratified, or
content-similar + old-score-band pairs. Callers may also POST an explicit
ordered item list. Either way the UI just consumes a queue in position order;
downstream consumers read the resulting annotation events, they don't drive it.
"""

from __future__ import annotations

from typing import Any, ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import ValidationException
from msgspec import Struct

from db.repositories.annotation_queues import AnnotationQueueRepo  # noqa: TC001  # DI needs runtime types
from scheme import DTOBaseModel

VALID_DIMENSIONS = {"color", "finish", "composition", "overall"}
VALID_SCALES = {2, 3, 5}
VALID_STRATEGIES = {"random", "stratified"}  # absolute sampling
VALID_PAIRWISE_STRATEGIES = {"random", "similar"}  # pairwise sampling


class AbsoluteQueueCreate(Struct):
    name: str
    dimensions: list[str]
    scale: int
    post_ids: list[int]


class PairwiseQueueCreate(Struct):
    name: str
    dimensions: list[str]
    pairs: list[tuple[int, int]]


class GenerateAbsoluteIn(Struct):
    dimensions: list[str]
    scale: int
    count: int
    strategy: str = "random"
    name: str | None = None


class GeneratePairwiseIn(Struct):
    dimension: str
    count: int
    strategy: str = "random"
    name: str | None = None


class QueueCreatedPublic(DTOBaseModel):
    id: int


class QueueSummaryPublic(DTOBaseModel):
    id: int
    name: str
    kind: str
    dimensions: list[str]
    scale: int | None = None
    total: int
    done: int


class QueueItemPostPublic(DTOBaseModel):
    id: int
    file_path: str
    file_name: str
    extension: str
    sha256: str
    width: int
    height: int


class AbsoluteQueueItemPublic(DTOBaseModel):
    position: int
    post: QueueItemPostPublic


class PairwiseQueueItemPublic(DTOBaseModel):
    position: int
    post_a: QueueItemPostPublic
    post_b: QueueItemPostPublic


def post_from_row(row: dict[str, Any], prefix: str = "") -> QueueItemPostPublic:
    return QueueItemPostPublic(
        id=row[f"{prefix}post_id"],
        file_path=row[f"{prefix}file_path"],
        file_name=row[f"{prefix}file_name"],
        extension=row[f"{prefix}extension"],
        sha256=row[f"{prefix}sha256"],
        width=row[f"{prefix}width"],
        height=row[f"{prefix}height"],
    )


class AnnotationQueueController(Controller):
    path = "/annotation-queues"
    tags: ClassVar[list[str]] = ["Annotations"]

    @litestar.post("/absolute", status_code=201, description="Create an absolute-annotation queue from an ordered post-id list.")
    async def create_absolute(self, annotation_queues: AnnotationQueueRepo, data: AbsoluteQueueCreate) -> QueueCreatedPublic:
        qid = await annotation_queues.create_absolute_queue(
            name=data.name, dimensions=data.dimensions, scale=data.scale, post_ids=data.post_ids,
        )
        return QueueCreatedPublic(id=qid)

    @litestar.post("/pairwise", status_code=201, description="Create a pairwise queue from an ordered (post_a, post_b) list.")
    async def create_pairwise(self, annotation_queues: AnnotationQueueRepo, data: PairwiseQueueCreate) -> QueueCreatedPublic:
        qid = await annotation_queues.create_pairwise_queue(
            name=data.name, dimensions=data.dimensions, pairs=[tuple(p) for p in data.pairs],
        )
        return QueueCreatedPublic(id=qid)

    @litestar.post(
        "/generate-absolute",
        status_code=201,
        description="Auto-generate an absolute queue by sampling the library (random / stratified by old score).",
    )
    async def generate_absolute(self, annotation_queues: AnnotationQueueRepo, data: GenerateAbsoluteIn) -> QueueSummaryPublic:
        if not data.dimensions or any(d not in VALID_DIMENSIONS for d in data.dimensions):
            msg = f"invalid dimensions: {data.dimensions!r}"
            raise ValidationException(msg)
        if data.scale not in VALID_SCALES:
            msg = f"invalid scale: {data.scale}"
            raise ValidationException(msg)
        if data.strategy not in VALID_STRATEGIES:
            msg = f"invalid strategy: {data.strategy!r}"
            raise ValidationException(msg)
        post_ids = await annotation_queues.sample_post_ids(count=data.count, strategy=data.strategy, dimensions=data.dimensions)
        if not post_ids:
            msg = "no eligible candidates (need posts with embeddings, not yet annotated or queued)"
            raise ValidationException(msg)
        name = data.name or f"{data.strategy}-{'+'.join(data.dimensions)}-{len(post_ids)}"
        qid = await annotation_queues.create_absolute_queue(name=name, dimensions=data.dimensions, scale=data.scale, post_ids=post_ids)
        return QueueSummaryPublic(id=qid, name=name, kind="absolute", dimensions=data.dimensions, scale=data.scale, total=len(post_ids), done=0)

    @litestar.post(
        "/generate-pairwise",
        status_code=201,
        description="Auto-generate a pairwise queue (random disjoint pairs, or content-similar + old-score-band pairs).",
    )
    async def generate_pairwise(self, annotation_queues: AnnotationQueueRepo, data: GeneratePairwiseIn) -> QueueSummaryPublic:
        if data.dimension not in VALID_DIMENSIONS:
            msg = f"invalid dimension: {data.dimension!r}"
            raise ValidationException(msg)
        if data.strategy not in VALID_PAIRWISE_STRATEGIES:
            msg = f"invalid strategy: {data.strategy!r}"
            raise ValidationException(msg)
        pairs = await annotation_queues.sample_pairs(count=data.count, strategy=data.strategy)
        if not pairs:
            msg = "no eligible candidates (need posts with embeddings, not already queued)"
            raise ValidationException(msg)
        name = data.name or f"pairs-{data.dimension}-{len(pairs)}"
        qid = await annotation_queues.create_pairwise_queue(name=name, dimensions=[data.dimension], pairs=pairs)
        return QueueSummaryPublic(id=qid, name=name, kind="pairwise", dimensions=[data.dimension], scale=None, total=len(pairs), done=0)

    @litestar.get("/", status_code=200, description="List queues with progress, newest first.")
    async def list_queues(self, annotation_queues: AnnotationQueueRepo) -> list[QueueSummaryPublic]:
        rows = await annotation_queues.list_queues()
        return [
            QueueSummaryPublic(id=q.id, name=q.name, kind=q.kind, dimensions=q.dimensions, scale=q.scale, total=total, done=done)
            for q, total, done in rows
        ]

    @litestar.get("/{queue_id:int}/next-absolute", status_code=200, description="Next undone items of an absolute queue, with image info.")
    async def next_absolute(self, annotation_queues: AnnotationQueueRepo, queue_id: int, limit: int = 20) -> list[AbsoluteQueueItemPublic]:
        items = await annotation_queues.next_absolute_items(queue_id, limit=limit)
        return [AbsoluteQueueItemPublic(position=r["position"], post=post_from_row(r)) for r in items]

    @litestar.get("/{queue_id:int}/next-pairwise", status_code=200, description="Next undone items of a pairwise queue, with image info for both posts.")
    async def next_pairwise(self, annotation_queues: AnnotationQueueRepo, queue_id: int, limit: int = 20) -> list[PairwiseQueueItemPublic]:
        items = await annotation_queues.next_pairwise_items(queue_id, limit=limit)
        return [
            PairwiseQueueItemPublic(position=r["position"], post_a=post_from_row(r, "a_"), post_b=post_from_row(r, "b_"))
            for r in items
        ]
