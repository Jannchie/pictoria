"""cairnq worker entry point — the process that owns the GPU.

Run it next to the API:

    cd server && uv run ./src/worker/main.py

The library root comes from `$PICTORIA_TARGET_DIR` (same variable, same default,
same repo-root anchor as `paths.ts`, resolved once in ``paths.target_dir()``) so
the API and this process cannot be pointed at different directories.
`--target_dir` is an explicit override for one-off runs.

Two things about this process are deliberate and worth keeping:

* **It never opens ``pictoria.sqlite``.** Not read-only, not "just for the
  embeddings". Everything a handler needs arrives in its payload and everything
  it produces goes back as JSON for TS to write (§D1). The only database this
  process touches is ``tasks.sqlite``, which is cairnq's alone.
* **``tasks.sqlite`` is a separate file** from the image library (§4.3). SQLite
  admits one writer at a time, and cairnq's lease renewals and heartbeats are
  frequent and small — exactly the traffic that would sit in front of a gallery
  write and make it wait.

``concurrency=1`` on the GPU queue replaces ``processors/gpu_pressure.py``: one
batch is in VRAM at a time and the queue holds the rest, rather than the API
process tracking pressure and shrinking batches itself.

Importing this module has no side effects (no dotenv, no logging setup, no
faulthandler) -- those happen in :func:`main` -- so ``tests/test_task_contracts.py``
can read :data:`TASKS` without configuring the process.
"""

from __future__ import annotations

import argparse
import asyncio
import faulthandler
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cairnq import SQLiteStore, Worker
from dotenv import load_dotenv

from paths import DEFAULT_TARGET_DIR, target_dir, tasks_db_path
from worker.handlers import (
    handle_basics,
    handle_caption,
    handle_dedup,
    handle_embedding,
    handle_lpips_verify,
    handle_rotate,
    handle_silva,
    handle_tagger,
    handle_text_embed,
    handle_thumbnail,
    handle_waifu,
    set_root,
)
from worker.importers import handle_danbooru_download, handle_danbooru_list, handle_url_download, handle_url_scan

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

log = logging.getLogger("worker")

#: Queue for background backfill. Polled at :data:`GPU_POLL_MS`, not cairnq's
#: default 500 ms: the backfill loops submit the next batch only after the last
#: one's result is back, so the worker is idle-polling at exactly the moment the
#: next batch lands, and every batch paid up to half a second of an idle GPU for
#: it. A busy worker does not poll at all (it waits on its running task), so the
#: tighter interval only costs while the queue is empty: one read-only
#: ``claimable_probe`` per poll, measured at ~0.19 ms through aiosqlite —
#: 20 a second is under 0.4% of one core. The interactive path (SigLIP text
#: encoding on ``/posts/search/text``) is a *different* queue; see §4.6, where
#: the default turned out to be a 626 ms trap for a synchronous request.
GPU_QUEUE = "gpu"
GPU_POLL_MS = 50

#: Queue for the interactive path (SigLIP text encoding behind
#: ``/posts/search/text``). Separate from ``GPU_QUEUE`` and served by its own
#: Worker so a search never queues behind a backfill batch, and polled far
#: tighter than the 500 ms default — that default is a 626 ms trap when a
#: human is waiting on the response (§4.6).
INTERACTIVE_QUEUE = "gpu-interactive"
INTERACTIVE_POLL_MS = 20

#: Queue for work that touches CPU and disk but never the GPU (thumbnails).
#: It gets its own Worker so it neither waits on a model batch nor makes one
#: wait, and unlike the GPU queue its concurrency can exceed 1.
IO_QUEUE = "io"
IO_CONCURRENCY = 4

#: Queue for CPU-only compute that must not sit in front of a request.
#: LPIPS arbitration for variant grouping lives here, and deliberately not on
#: ``IO_QUEUE``: thumbnails are generated *on demand* when the image route is
#: hit, so a half-hour arbitration run sharing that queue would make image
#: loads wait behind it. Not the GPU queue either -- the card already carries
#: four models, and a 400x400 AlexNet is 20-40 ms on CPU.
CPU_QUEUE = "cpu"
#: Two at a time against ``ai.lpips``'s four intra-op threads -- eight of the
#: box's cores at full tilt, leaving the rest to the GPU worker's decoding.
CPU_CONCURRENCY = 2

#: Every task this process serves: name -> (queue, handler). The names are the
#: ``defineTask`` strings in ``packages/contracts/src/tasks.ts``; the contract
#: fixtures under ``packages/contracts/fixtures/tasks/`` pin both columns from
#: the TS side, and ``tests/test_task_contracts.py`` checks this table against
#: them.
#:
#: ``silva`` serves both heads (``silva`` and ``silva_luna`` are the same code
#: path with different learnt weights; the payload says which). ``dedup`` is
#: not a backfill worker — it is one whole-library pass, kicked off by
#: /v2/cmd/group-duplicates or by the embedding scheduler after it writes new
#: vectors — but it shares the GPU queue on purpose: it wants the GPU
#: exclusively.
TASKS: dict[str, tuple[str, Handler]] = {
    "silva": (GPU_QUEUE, handle_silva),
    "waifu": (GPU_QUEUE, handle_waifu),
    "tagger": (GPU_QUEUE, handle_tagger),
    "embedding": (GPU_QUEUE, handle_embedding),
    "dedup": (GPU_QUEUE, handle_dedup),
    "text-embed": (INTERACTIVE_QUEUE, handle_text_embed),
    "lpips-verify": (CPU_QUEUE, handle_lpips_verify),
    "thumbnail": (IO_QUEUE, handle_thumbnail),
    "rotate": (IO_QUEUE, handle_rotate),
    "caption": (IO_QUEUE, handle_caption),
    "basics": (IO_QUEUE, handle_basics),
    "danbooru-list": (IO_QUEUE, handle_danbooru_list),
    "danbooru-download": (IO_QUEUE, handle_danbooru_download),
    "url-scan": (IO_QUEUE, handle_url_scan),
    "url-download": (IO_QUEUE, handle_url_download),
}


def _adapt(handler: Handler) -> Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]:
    """cairnq's ``(ctx, payload)`` convention around a payload-only handler.

    A real ``async def`` rather than a lambda returning the coroutine: cairnq
    runs a non-async callable on a worker thread first, a pointless hop here.
    """

    async def run(_ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
        return await handler(payload)

    return run


def _configure_process() -> None:
    """Process-wide setup, kept out of import time (see the module docstring)."""
    # The importers need DANBOORU_API_KEY / DANBOORU_USER_NAME out of server/.env.
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # A native crash in this process leaves *nothing* behind by default: the GPU
    # stack is C++ and CUDA, so an access violation kills the interpreter without
    # an exception, without a traceback and without a Windows event-log entry.
    # The symptom is a bare "Command failed with exit code 3221225477" from pnpm,
    # and the only way to find out which handler was in the middle of it is to
    # go read what cairnq left marked ``running``.
    #
    # faulthandler catches SIGSEGV / SIGABRT / SIGFPE / SIGILL and dumps every
    # thread's Python stack first. It costs nothing until something crashes,
    # which is exactly the trade this process wants: a rare crash 40 minutes into
    # a 16-hour backfill is expensive to reproduce and cheap to instrument for.
    faulthandler.enable()


async def main() -> None:
    _configure_process()
    parser = argparse.ArgumentParser(description="pictoria cairnq worker")
    parser.add_argument(
        "--target_dir",
        type=Path,
        default=None,
        help=f"image library root; overrides $PICTORIA_TARGET_DIR (default: {DEFAULT_TARGET_DIR})",
    )
    parser.add_argument("--tasks_db", type=Path, default=None, help="override the tasks.sqlite path")
    args = parser.parse_args()

    # The flag resolves against the cwd (that is what a user typing a path
    # expects); the env var resolves against the repo root, because that is
    # where paths.ts resolves it and the two must agree.
    root = args.target_dir.resolve() if args.target_dir else target_dir()
    db_path = args.tasks_db.resolve() if args.tasks_db else tasks_db_path(root)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    log.info("library root: %s", root)
    log.info("tasks db: %s", db_path)

    store = SQLiteStore(str(db_path))
    workers: dict[str, Worker] = {
        GPU_QUEUE: Worker(store, queues=[GPU_QUEUE], concurrency=1, poll_interval_ms=GPU_POLL_MS),
        # A second Worker rather than a second queue on the same one: with
        # concurrency=1 a single worker would still make a search wait out
        # whatever batch is in flight.
        INTERACTIVE_QUEUE: Worker(
            store,
            queues=[INTERACTIVE_QUEUE],
            concurrency=1,
            poll_interval_ms=INTERACTIVE_POLL_MS,
        ),
        IO_QUEUE: Worker(
            store,
            queues=[IO_QUEUE],
            concurrency=IO_CONCURRENCY,
            poll_interval_ms=INTERACTIVE_POLL_MS,
        ),
        # Default poll interval: arbitration arrives in batches during a rebuild
        # and nobody is watching the clock on any one of them.
        CPU_QUEUE: Worker(store, queues=[CPU_QUEUE], concurrency=CPU_CONCURRENCY),
    }

    # Payload paths are resolved inside this root and nowhere else.
    set_root(root)

    for name, (queue, handler) in TASKS.items():
        workers[queue].task(name)(_adapt(handler))

    for queue in workers:
        log.info("worker up on %s: %s", queue, ", ".join(n for n, (q, _) in TASKS.items() if q == queue))
    await asyncio.gather(*(w.run() for w in workers.values()))


if __name__ == "__main__":
    asyncio.run(main())
