"""asyncbridge — turn a synchronous data-access method into an async one.

The data-access layer is synchronous SQLite (a ``DB``-issued cursor bound to
the calling thread). To keep those blocking calls off the event loop, each
public repository / query method historically wrapped its body in a nested
``_impl`` closure and returned ``await asyncio.to_thread(_impl)``.

``in_thread`` collapses that boilerplate: decorate the *synchronous* method and
callers still ``await`` it, but the whole body runs on a worker thread via
``asyncio.to_thread`` — semantically identical to the old ``_impl`` closure
(the closure captured its arguments and ran in the pool thread; the decorator
passes the same arguments and runs the same body in the pool thread).

``DB._new_connection`` sets ``check_same_thread=False`` and hands out a
thread-local connection per worker thread, so a cursor used inside the threaded
body stays valid.
"""

from __future__ import annotations

import asyncio
import functools
from typing import TYPE_CHECKING, ParamSpec, TypeVar

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

P = ParamSpec("P")
R = TypeVar("R")


def in_thread(fn: Callable[P, R]) -> Callable[P, Awaitable[R]]:
    """Run the decorated sync function in a worker thread via ``asyncio.to_thread``.

    The returned wrapper is an ``async def`` with the same call signature as
    ``fn`` (``ParamSpec`` preserves it); ``await``-ing it runs ``fn`` on a
    thread-pool worker and yields its return value. Exceptions propagate
    unchanged, exactly as they did through the old ``asyncio.to_thread(_impl)``.
    """

    @functools.wraps(fn)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        return await asyncio.to_thread(fn, *args, **kwargs)

    return wrapper
