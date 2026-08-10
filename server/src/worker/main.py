"""cairnq worker entry point — the process that owns the GPU.

Run it next to the API:

    cd server && uv run ./src/worker/main.py --target_dir ./illustration/images

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
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

from cairnq import SQLiteStore, Worker

from worker.handlers import (
    handle_dedup,
    handle_embedding,
    handle_silva,
    handle_tagger,
    handle_text_embed,
    handle_waifu,
    set_root,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")

#: Queue for background backfill. Its poll interval is cairnq's default 500 ms
#: on purpose — a backfill task that starts half a second late costs nothing,
#: and a tighter interval just spends queries on an empty table. The
#: interactive path (SigLIP text encoding on ``/posts/search/text``) is a
#: *different* queue with a much tighter poll; see §4.6, where the default
#: turned out to be a 626 ms trap for a synchronous request.
GPU_QUEUE = "gpu"

#: Queue for the interactive path (SigLIP text encoding behind
#: ``/posts/search/text``). Separate from ``GPU_QUEUE`` and served by its own
#: Worker so a search never queues behind a backfill batch, and polled far
#: tighter than the 500 ms default — that default is a 626 ms trap when a
#: human is waiting on the response (§4.6).
INTERACTIVE_QUEUE = "gpu-interactive"
INTERACTIVE_POLL_MS = 20


def tasks_db_path(target_dir: Path) -> Path:
    return target_dir / ".pictoria" / "tasks.sqlite"


async def main() -> None:
    parser = argparse.ArgumentParser(description="pictoria cairnq worker")
    parser.add_argument("--target_dir", type=Path, required=True, help="image library root")
    parser.add_argument("--tasks_db", type=Path, default=None, help="override the tasks.sqlite path")
    args = parser.parse_args()

    db_path = args.tasks_db or tasks_db_path(args.target_dir)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    store = SQLiteStore(str(db_path))
    worker = Worker(store, queues=[GPU_QUEUE], concurrency=1)
    # A second Worker rather than a second queue on the same one: with
    # concurrency=1 a single worker would still make a search wait out
    # whatever batch is in flight.
    interactive = Worker(
        store,
        queues=[INTERACTIVE_QUEUE],
        concurrency=1,
        poll_interval_ms=INTERACTIVE_POLL_MS,
    )

    # Payload paths are resolved inside this root and nowhere else.
    set_root(args.target_dir)

    # ``silva`` and ``silva_luna`` are the same code path with different learnt
    # weights, so one handler serves both names and the payload says which head.
    worker.task("silva")(lambda _ctx, payload: handle_silva(payload))
    worker.task("waifu")(lambda _ctx, payload: handle_waifu(payload))
    worker.task("tagger")(lambda _ctx, payload: handle_tagger(payload))
    worker.task("embedding")(lambda _ctx, payload: handle_embedding(payload))
    # dedup is not a backfill worker — it is one whole-library pass, kicked off by
    # /v2/cmd/group-duplicates or by the embedding scheduler after it writes new
    # vectors. Same queue on purpose: it wants the GPU exclusively.
    worker.task("dedup")(lambda _ctx, payload: handle_dedup(payload))
    interactive.task("text-embed")(lambda _ctx, payload: handle_text_embed(payload))

    log.info(
        "worker up: silva, waifu, tagger, embedding, dedup on %s; text-embed on %s  db=%s",
        GPU_QUEUE,
        INTERACTIVE_QUEUE,
        db_path,
    )
    await asyncio.gather(worker.run(), interactive.run())


if __name__ == "__main__":
    asyncio.run(main())
