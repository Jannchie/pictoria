"""cairnq worker entry point — the process that owns the GPU.

Run it next to the API:

    cd server && uv run ./src/worker/main.py

The library root comes from `$PICTORIA_TARGET_DIR` (same variable, same default,
same repo-root anchor as `paths.ts`) so the API and this process cannot be pointed
at different directories. `--target_dir` is an explicit override for one-off runs.

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
import os
from pathlib import Path

from cairnq import SQLiteStore, Worker
from dotenv import load_dotenv

from worker.handlers import (
    handle_basics,
    handle_caption,
    handle_dedup,
    handle_embedding,
    handle_rotate,
    handle_silva,
    handle_tagger,
    handle_text_embed,
    handle_thumbnail,
    handle_waifu,
    set_root,
)
from worker.importers import handle_danbooru_import, handle_url_download, handle_url_scan

#: The importers need DANBOORU_API_KEY / DANBOORU_USER_NAME out of server/.env —
#: the same file bootstrap.py loads for the API process.
load_dotenv()

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

#: Queue for work that touches CPU and disk but never the GPU (thumbnails).
#: It gets its own Worker so it neither waits on a model batch nor makes one
#: wait, and unlike the GPU queue its concurrency can exceed 1.
IO_QUEUE = "io"
IO_CONCURRENCY = 4


#: Repo root, derived from this file's location rather than the cwd -- same
#: reasoning as ``paths.ts``'s REPO_ROOT: the cwd depends on how you launched
#: (``pnpm dev:worker`` cd's into ``server/``), so a relative config value would
#: mean two different directories to the two halves. This file is
#: ``server/src/worker/main.py``, hence three parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]

#: Must stay byte-identical to ``paths.ts``'s fallback in ``targetDir()``.
_DEFAULT_TARGET_DIR = "server/illustration/images"


def target_dir() -> Path:
    """The image library root. Mirrors ``paths.ts``'s ``targetDir()`` exactly.

    Both halves have to land on the same directory or the failure is silent:
    the API submits to one ``tasks.sqlite`` while the worker polls another, so
    every ``tasks.call`` just runs out its timeout (60 s for a thumbnail, 60 min
    for a danbooru import) with nothing logged. A mismatched *root* is worse --
    ``_resolve_inside`` rejects the payload paths as escaping it, which is a
    *per-item* failure, so TS writes every post into ``post_process_failures``,
    a permanent blacklist that fixing the config does not undo.

    That is why the env var, the default, and the repo-root anchor are all
    duplicated from ``paths.ts`` rather than the worker taking a required
    ``--target_dir``: a flag that only one of the two processes reads is exactly
    how the two drift apart.
    """
    return (_REPO_ROOT / os.environ.get("PICTORIA_TARGET_DIR", _DEFAULT_TARGET_DIR)).resolve()


def tasks_db_path(root: Path) -> Path:
    """cairnq's queue database. Mirrors ``paths.ts``'s ``tasksDbPath()``.

    The ``TASKS_DB_PATH`` override lives *here* rather than at the call site so
    that this function is the whole rule -- on the TS side it is one expression,
    and splitting default from override across two places is how the next reader
    gets a different answer than the code does.

    A relative override is anchored at the *repo root*, same as
    ``PICTORIA_TARGET_DIR`` -- never at the cwd. This process's cwd is
    ``server/`` (``pnpm dev:worker`` cd's there) while the API's is the repo
    root, so cwd-relative resolution is exactly the split-brain described in
    ``target_dir()``: two processes silently opening two different queue files.
    """
    override = os.environ.get("TASKS_DB_PATH")
    return (_REPO_ROOT / override).resolve() if override else root / ".pictoria" / "tasks.sqlite"


async def main() -> None:
    parser = argparse.ArgumentParser(description="pictoria cairnq worker")
    parser.add_argument(
        "--target_dir",
        type=Path,
        default=None,
        help=f"image library root; overrides $PICTORIA_TARGET_DIR (default: {_DEFAULT_TARGET_DIR})",
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
    io_worker = Worker(
        store,
        queues=[IO_QUEUE],
        concurrency=IO_CONCURRENCY,
        poll_interval_ms=INTERACTIVE_POLL_MS,
    )

    # Payload paths are resolved inside this root and nowhere else.
    set_root(root)

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
    io_worker.task("thumbnail")(lambda _ctx, payload: handle_thumbnail(payload))
    io_worker.task("rotate")(lambda _ctx, payload: handle_rotate(payload))
    io_worker.task("caption")(lambda _ctx, payload: handle_caption(payload))
    io_worker.task("basics")(lambda _ctx, payload: handle_basics(payload))
    io_worker.task("danbooru-import")(lambda _ctx, payload: handle_danbooru_import(payload))
    io_worker.task("url-scan")(lambda _ctx, payload: handle_url_scan(payload))
    io_worker.task("url-download")(lambda _ctx, payload: handle_url_download(payload))

    log.info(
        "worker up: silva, waifu, tagger, embedding, dedup on %s; text-embed on %s; thumbnail + rotate + caption + basics + import on %s  db=%s",
        GPU_QUEUE,
        INTERACTIVE_QUEUE,
        IO_QUEUE,
        db_path,
    )
    await asyncio.gather(worker.run(), interactive.run(), io_worker.run())


if __name__ == "__main__":
    asyncio.run(main())
