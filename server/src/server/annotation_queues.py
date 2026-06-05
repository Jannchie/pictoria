"""Annotation queue endpoints: create queues (fed by silva samplers), serve next items.

Queues carry no sampling logic — silva-side scripts decide what to annotate
(coldstart coverage, OOF disagreement, boundary pairs) and POST ordered item
lists here; the UI just consumes them in position order.
"""

from __future__ import annotations

from typing import Any, ClassVar

import litestar
from litestar import Controller
from msgspec import Struct

from db.repositories.annotation_queues import AnnotationQueueRepo  # noqa: TC001  # DI needs runtime types
from scheme import DTOBaseModel


class AbsoluteQueueCreate(Struct):
    name: str
    dimensions: list[str]
    scale: int
    post_ids: list[int]


class PairwiseQueueCreate(Struct):
    name: str
    dimensions: list[str]
    pairs: list[tuple[int, int]]


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


def _post_from_prefix(row: dict[str, Any], prefix: str = "") -> QueueItemPostPublic:
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
        return [AbsoluteQueueItemPublic(position=r["position"], post=_post_from_prefix(r)) for r in items]

    @litestar.get("/{queue_id:int}/next-pairwise", status_code=200, description="Next undone items of a pairwise queue, with image info for both posts.")
    async def next_pairwise(self, annotation_queues: AnnotationQueueRepo, queue_id: int, limit: int = 20) -> list[PairwiseQueueItemPublic]:
        items = await annotation_queues.next_pairwise_items(queue_id, limit=limit)
        return [
            PairwiseQueueItemPublic(position=r["position"], post_a=_post_from_prefix(r, "a_"), post_b=_post_from_prefix(r, "b_"))
            for r in items
        ]
