"""Filesystem watcher — pushes debounced change notifications into asyncio.

The watcher runs in a watchdog observer thread (separate from the asyncio
event loop) and uses ``asyncio.run_coroutine_threadsafe`` to schedule the
sync coroutine back on the main loop. Bursty events (e.g. a 1000-file
copy) are coalesced via a per-watcher debounce timer, so the heavy
``sync_metadata`` call runs at most once per quiet interval — not once
per inode touched.

The legacy polling loop in ``app.py`` is still kept as a long-interval
safety net (in case watchdog misses events on some filesystems / SMB
shares / network mounts), but the watcher is the primary trigger.
"""

from __future__ import annotations

import asyncio
import threading
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

import shared
from shared import logger

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from pathlib import Path


# How long to wait after the LAST filesystem event before firing the sync.
# Bursty operations (mass copy, rsync) emit thousands of events in quick
# succession; debouncing collapses them into a single sync invocation.
_DEBOUNCE_S = 1.5


class _DebouncedHandler(FileSystemEventHandler):
    def __init__(self, notify: Callable[[], None]) -> None:
        super().__init__()
        self._notify = notify
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = str(event.src_path)
        # Don't react to our own thumbnail / sqlite writes — they live under
        # ``.pictoria`` and would otherwise feedback-loop the sync.
        if src.startswith(str(shared.pictoria_dir)):
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(_DEBOUNCE_S, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        with self._lock:
            self._timer = None
        try:
            self._notify()
        except Exception:
            logger.exception("Watcher notify failed")


class AsyncWatcher:
    """Schedule an asyncio coroutine when the watched tree changes."""

    def __init__(
        self,
        directory: Path,
        loop: asyncio.AbstractEventLoop,
        on_change: Callable[[], Awaitable[None]],
    ) -> None:
        self._directory = directory
        self._loop = loop
        self._on_change = on_change
        self._observer = Observer()
        self._handler = _DebouncedHandler(self._schedule)

    def _schedule(self) -> None:
        # Called from watchdog's observer thread; bounce onto the asyncio loop.
        asyncio.run_coroutine_threadsafe(self._safe_run(), self._loop)

    async def _safe_run(self) -> None:
        try:
            await self._on_change()
        except Exception:
            logger.exception("Watcher-triggered sync failed")

    def start(self) -> None:
        self._observer.schedule(self._handler, str(self._directory), recursive=True)
        self._observer.start()
        logger.info(f"Watcher started on {self._directory}")

    def stop(self) -> None:
        try:
            self._observer.stop()
            self._observer.join(timeout=5)
        except Exception:
            logger.exception("Watcher stop failed")
