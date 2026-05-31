"""Regression test for request-scoped connection isolation.

Pins the root-cause fix for the intermittent ``KeyError('score')`` in the
``/count/*`` endpoints: request-scoped cursors were created in the event-loop
thread and all bound the SAME thread-local connection, so concurrent
``asyncio.to_thread`` executions on that shared connection desynced
``cursor.description`` (score-count read rating-count's column names). The fix
gives each request its own connection; this test pins that invariant.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING

from server.dependencies import _cursor_scoped

if TYPE_CHECKING:
    from db.connection import DB


async def test_cursor_scoped_uses_a_distinct_connection_per_request(db: DB) -> None:
    provider = _cursor_scoped(lambda cur: cur)
    state = SimpleNamespace(db=db)

    gen1 = provider(state)
    gen2 = provider(state)
    cur1 = await gen1.__anext__()
    cur2 = await gen2.__anext__()
    try:
        # Pre-fix both cursors shared one thread-local connection — exactly what
        # let concurrent to_thread execs corrupt each other's cursor state.
        assert cur1.connection is not cur2.connection
    finally:
        await gen1.aclose()
        await gen2.aclose()
