"""Per-request dependency providers wiring SQLite cursors into the repos.

Every repository/query-service takes a thread-local cursor and is scoped to a
single request: open a cursor, hand it to the repo, close it when the request
ends. That open/try-yield/finally-close dance is identical for every repo, so
it lives once in ``_cursor_scoped`` instead of being copy-pasted per provider.

These providers live in their own module (rather than ``app.py``) so tests can
import the real wiring without pulling in ``app.py``'s heavy ML/processor
imports.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar

from db.queries.post_query import PostQueryService
from db.repositories.annotation_queues import AnnotationQueueRepo
from db.repositories.annotations import AnnotationRepo
from db.repositories.posts import PostRepo
from db.repositories.scores import ScoreRepo
from db.repositories.tags import TagGroupRepo, TagRepo
from db.repositories.vectors import SIGLIP2_DIM, SIGLIP2_TABLE, VectorRepo
from services.intake import UploadIntake

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import AsyncGenerator, Callable

    from litestar.datastructures import State

T = TypeVar("T")


def _cursor_scoped(make: Callable[[sqlite3.Cursor], T]) -> Callable[[State], AsyncGenerator[T, None]]:
    """Build a request-scoped provider that opens/closes a cursor around ``make``."""

    async def provide(state: State) -> AsyncGenerator[T, None]:
        # Each request gets its OWN connection — not the event-loop thread's
        # shared thread-local one. The cursor is created here (event-loop
        # thread) but its SQL runs on asyncio.to_thread worker threads; when
        # several concurrent requests shared one connection, their parallel
        # execs desynced cursor.description and e.g. /count/score read
        # /count/rating's column names -> KeyError('score'). A dedicated
        # connection per request isolates that state entirely (see
        # DB.new_connection's docstring).
        conn = state.db.new_connection()
        try:
            yield make(conn.cursor())
        finally:
            state.db.discard_connection(conn)

    return provide


provide_post_repo = _cursor_scoped(PostRepo)
provide_tag_repo = _cursor_scoped(TagRepo)
provide_tag_group_repo = _cursor_scoped(TagGroupRepo)
provide_vector_repo = _cursor_scoped(lambda cur: VectorRepo(cur, table=SIGLIP2_TABLE, dim=SIGLIP2_DIM))
provide_post_query = _cursor_scoped(PostQueryService)
provide_score_repo = _cursor_scoped(ScoreRepo)
provide_annotation_repo = _cursor_scoped(AnnotationRepo)
provide_annotation_queue_repo = _cursor_scoped(AnnotationQueueRepo)
# The upload workflow needs three repos sharing one request-scoped cursor.
provide_upload_intake = _cursor_scoped(
    lambda cur: UploadIntake(PostRepo(cur), VectorRepo(cur, table=SIGLIP2_TABLE, dim=SIGLIP2_DIM), TagGroupRepo(cur)),
)


# Dependency-key -> provider, ready to splat into ``Litestar(dependencies=...)``.
REQUEST_DEPENDENCIES = {
    "posts": provide_post_repo,
    "post_query": provide_post_query,
    "tag_repo": provide_tag_repo,
    "tag_group_repo": provide_tag_group_repo,
    "vectors": provide_vector_repo,
    "scores": provide_score_repo,
    "upload_intake": provide_upload_intake,
    "annotations": provide_annotation_repo,
    "annotation_queues": provide_annotation_queue_repo,
}
