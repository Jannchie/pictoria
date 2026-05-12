"""Filesystem watcher — schedules DB syncs on disk changes.

Native DuckDB version: the watcher no longer holds its own DB connection.
Instead, it pushes change notifications into a queue that the app's main
event loop drains using its shared DB.

For now we keep the watcher disabled in the default lifespan (see app.py);
this module remains available for future re-enablement.
"""

from __future__ import annotations

import signal
import threading
import time
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from pathlib import Path

import shared
from shared import logger


class Watcher:
    def __init__(self, directory_to_watch: Path) -> None:
        self.directory_to_watch = directory_to_watch
        self.observer = Observer()

    def run(self) -> None:
        event_handler = Handler()
        self.observer.schedule(event_handler, self.directory_to_watch, recursive=True)
        logger.info("Starting watcher")
        self.observer.start()
        while not shared.stop_event.is_set():
            time.sleep(1)
        logger.info("Stopping watcher")
        self.observer.stop()
        self.observer.join()

    def stop(self) -> None:
        shared.should_watch = False


class Handler(FileSystemEventHandler):
    """Logs file events. Concrete DB sync is deferred to a future change
    (would require an asyncio handle to the app's running DB)."""

    def __init__(self, debounce_time: int = 1) -> None:
        super().__init__()
        self.last_event_times: dict[tuple[str, str], float] = {}
        self.debounce_time = debounce_time
        self.lock = threading.Lock()

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.src_path.startswith(str(shared.pictoria_dir)):
            return
        if event.is_directory:
            return
        event_key = (event.src_path, event.event_type)
        current_time = time.time()
        with self.lock:
            last = self.last_event_times.get(event_key, 0)
            if current_time - last < self.debounce_time:
                return
            self.last_event_times[event_key] = current_time
        logger.debug(f"Watcher event: {event.event_type} - {event.src_path}")
        # Note: actual sync deferred. Trigger /cmd/posts/embedding etc. manually
        # or call processors.sync_metadata from a console.


def watch_target_dir() -> None:
    w = Watcher(shared.target_dir)
    threading.Thread(target=w.run).start()


def signal_handler(*_: tuple) -> None:
    logger.info("Exit signal received, stopping threads...")
    shared.stop_event.set()


signal.signal(signal.SIGINT, signal_handler)
