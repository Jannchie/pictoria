"""Annotation endpoints: submit append-only events, read per-post history.

Requests are msgspec Structs (snake_case, like ``PostFilter``); responses are
``DTOBaseModel`` (camelCase). Submitting with ``queue_id``/``queue_position``
marks the queue item done in the same request.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003  # Pydantic needs runtime types
from typing import Any, ClassVar

import litestar
from litestar import Controller
from litestar.exceptions import ValidationException
from msgspec import Struct

from db.repositories.annotation_queues import AnnotationQueueRepo  # noqa: TC001  # DI needs runtime types
from db.repositories.annotations import MUTABLE_KINDS, AnnotationRepo
from scheme import DTOBaseModel
from server.annotation_queues import VALID_PAIRWISE_STRATEGIES, QueueItemPostPublic, post_from_row

VALID_DIMENSIONS = {"color", "finish", "composition", "overall"}
VALID_FLAGS = {"love", "hate", "none"}
VALID_WINNERS = {"a", "b", "tie", "skip"}
VALID_SCALES = {2, 3, 5}
# One page of the history sidebar. Capped so a hand-written `limit` cannot ask for the
# whole table plus a posts fetch per row.
TIMELINE_MAX_LIMIT = 100


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


class UndoIn(Struct):
    """Retract events this session just submitted, and re-open their queue item."""

    kind: str
    ids: list[int]
    session_id: str
    queue_id: int | None = None
    queue_position: int | None = None


class InsertedPublic(DTOBaseModel):
    inserted: int
    # Row ids of the inserted events, so the client can hand them back to /undo.
    # Without them undo would have to guess which row it wrote by re-querying on
    # (post, dimension, session) and taking the newest — wrong the moment the
    # same pair is judged twice in one session.
    ids: list[int]


class DeletedPublic(DTOBaseModel):
    deleted: int


class UpdatedPublic(DTOBaseModel):
    # 0 = no row matched. Not InsertedPublic: an edit inserts nothing, and sharing that
    # model would put "inserted"/"ids" in this endpoint's contract and drag any future
    # field on it along too.
    updated: int


class EditIn(Struct):
    """Correct one already-submitted verdict. ``verdict`` is a winner or a scale value.

    ``kind`` is not here: it is already in the path, and a second copy in the body
    exists only to be asserted equal to the first.
    """

    verdict: int | str


class TimelineEntryPublic(DTOBaseModel):
    """One row of the merged annotation history.

    Flat rather than a tagged union per kind: the three kinds share a row layout in the
    list and differ only in which verdict field is filled, and a discriminated union
    would make the generated TypeScript client narrow on every access for no gain.
    """

    kind: str  # 'pairwise' | 'absolute' | 'flag'
    id: int
    created_at: datetime
    post: QueueItemPostPublic
    post_b: QueueItemPostPublic | None = None  # pairwise only
    dimension: str | None = None  # flags carry none
    winner: str | None = None  # pairwise
    scale: int | None = None  # absolute
    value: int | None = None  # absolute
    flag: str | None = None  # content flag
    edited_at: datetime | None = None  # non-NULL => verdict was corrected later


class TimelinePagePublic(DTOBaseModel):
    items: list[TimelineEntryPublic]
    # None = the stream is exhausted. Set whenever a FULL page of raw events came back,
    # which is not the same as a full page of items: an event whose post was deleted is
    # dropped, so a short page can still have more behind it. Callers page until this is
    # None rather than until a page looks short.
    next_cursor: str | None = None


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
    edited_at: datetime | None = None


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
    edited_at: datetime | None = None


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


_CURSOR_PARTS = 3


def _make_cursor(row: dict[str, Any]) -> str:
    """``created_at|kind|id`` — the merged stream's total order, as one opaque token.

    Opaque to the client on purpose: it is a sort position, not a row id, and encoding
    the three parts means the next page resumes exactly where this one stopped even
    though ids only increase within a single table.

    Only ever built for the LAST RAW row of a page, never per entry: a row whose post
    was deleted is dropped from ``items``, so the last visible entry is not where the
    page stopped and resuming from it would re-serve whatever was dropped.
    """
    return f"{row['created_at']}|{row['kind']}|{row['id']}"


def _parse_cursor(raw: str | None) -> tuple[str, str, int] | None:
    if not raw:
        return None
    parts = raw.split("|")
    if len(parts) != _CURSOR_PARTS or not all(parts) or not parts[2].isdigit():
        msg = f"malformed cursor: {raw!r}"
        raise ValidationException(msg)
    created_at, kind, id_text = parts
    return created_at, kind, int(id_text)


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
        ids = [
            await annotations.insert_absolute(
                post_id=e.post_id,
                dimension=e.dimension,
                scale=e.scale,
                value=e.value,
                rubric_version=e.rubric_version,
                session_id=e.session_id,
                elapsed_ms=e.elapsed_ms,
            )
            for e in data.events
        ]
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind="absolute", position=data.queue_position)
        return InsertedPublic(inserted=len(ids), ids=ids)

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
        row_id = await annotations.insert_pairwise(
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
        return InsertedPublic(inserted=1, ids=[row_id])

    @litestar.post(
        "/content-flag",
        status_code=201,
        description="Record a content taste flag for a post ('none' = retract).",
    )
    async def submit_content_flag(self, annotations: AnnotationRepo, data: ContentFlagIn) -> InsertedPublic:
        if data.flag not in VALID_FLAGS:
            msg = f"invalid flag: {data.flag!r}"
            raise ValidationException(msg)
        row_id = await annotations.insert_content_flag(post_id=data.post_id, flag=data.flag, session_id=data.session_id)
        return InsertedPublic(inserted=1, ids=[row_id])

    @litestar.post(
        "/undo",
        status_code=200,
        description=(
            "Retract annotation events this session just submitted (a mis-click). Deletes the rows outright "
            "rather than flagging them, so they never reach training exports or the sampler's comparison graph. "
            "Only events whose session_id matches are touched. Also re-opens the queue item, if one was given."
        ),
    )
    async def undo_annotations(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        data: UndoIn,
    ) -> DeletedPublic:
        if data.kind not in MUTABLE_KINDS:
            msg = f"invalid kind: {data.kind!r}"
            raise ValidationException(msg)
        deleted = await annotations.undo(kind=data.kind, ids=data.ids, session_id=data.session_id)
        # An empty ``ids`` is legitimate: a skipped queue item is marked done without
        # writing an event, so its undo is the un-marking alone.
        if data.queue_id is not None and data.queue_position is not None:
            await annotation_queues.mark_done(data.queue_id, kind=data.kind, position=data.queue_position, done=False)
        return DeletedPublic(deleted=deleted)

    @litestar.patch(
        "/{kind:str}/{annotation_id:int}",
        status_code=200,
        description=(
            "Correct one already-submitted verdict IN PLACE (kind = 'pairwise' | 'absolute'). "
            "Not an appended correction: pairwise exports one row per judgement with no latest-wins "
            "pass, so a second row would leave the wrong verdict in the training set. Stamps edited_at."
        ),
    )
    async def edit_annotation(self, annotations: AnnotationRepo, kind: str, annotation_id: int, data: EditIn) -> UpdatedPublic:
        if kind not in MUTABLE_KINDS:
            msg = f"invalid kind: {kind!r}"
            raise ValidationException(msg)
        if kind == "pairwise" and data.verdict not in VALID_WINNERS:
            msg = f"invalid winner: {data.verdict!r}"
            raise ValidationException(msg)
        if kind == "absolute" and not (isinstance(data.verdict, int) and data.verdict >= 1):
            msg = f"invalid value: {data.verdict!r}"
            raise ValidationException(msg)
        changed = await annotations.edit(kind=kind, annotation_id=annotation_id, verdict=data.verdict)
        return UpdatedPublic(updated=int(changed))

    @litestar.get(
        "/timeline",
        status_code=200,
        description=(
            "Everything submitted so far, newest first, across all three event kinds. Cursor-paged: "
            "pass the previous page's nextCursor as 'before'. Cursor rather than offset because the "
            "head of this list grows while it is being scrolled."
        ),
    )
    async def annotation_timeline(
        self,
        annotations: AnnotationRepo,
        annotation_queues: AnnotationQueueRepo,
        limit: int = 30,
        before: str | None = None,
    ) -> TimelinePagePublic:
        page = min(max(limit, 1), TIMELINE_MAX_LIMIT)
        rows = await annotations.timeline(limit=page, before=_parse_cursor(before))
        rows_by_id = await annotation_queues.posts_by_id([pid for r in rows for pid in (r["post"], r["post_b"]) if pid])
        posts = {pid: post_from_row(row) for pid, row in rows_by_id.items()}
        items = [
            TimelineEntryPublic(
                kind=r["kind"],
                id=r["id"],
                created_at=r["created_at"],
                post=posts[r["post"]],
                post_b=posts.get(r["post_b"]) if r["post_b"] else None,
                dimension=r["dimension"],
                winner=r["winner"],
                scale=r["scale"],
                value=r["value"],
                flag=r["flag"],
                edited_at=r["edited_at"],
            )
            for r in rows
            # A post deleted since the judgement leaves an event with nothing to show.
            # Dropping it here keeps the page honest rather than rendering a broken tile.
            if r["post"] in posts and (not r["post_b"] or r["post_b"] in posts)
        ]
        return TimelinePagePublic(items=items, next_cursor=_make_cursor(rows[-1]) if len(rows) == page else None)

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
        description=(
            "Queue-less streaming: sample pairs for pairwise annotation. 'close' (default) = visually similar and "
            "hard for the model, extending the comparison graph already collected for this dimension; "
            "'similar' = model-agnostic content-similar + old-score band; 'random' = uniform."
        ),
    )
    async def sample_pairwise(
        self,
        annotation_queues: AnnotationQueueRepo,
        limit: int = 10,
        strategy: str = "close",
        dimension: str = "overall",
    ) -> list[SampledPairPublic]:
        if strategy not in VALID_PAIRWISE_STRATEGIES:
            msg = f"invalid strategy: {strategy!r}"
            raise ValidationException(msg)
        if dimension not in VALID_DIMENSIONS:
            msg = f"invalid dimension: {dimension!r}"
            raise ValidationException(msg)
        items = await annotation_queues.sample_pairwise_items(count=limit, strategy=strategy, dimension=dimension)
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
