import asyncio
import contextlib
import os
import pathlib
import re
import tomllib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pillow_avif  # noqa: F401
from dotenv import load_dotenv
from litestar import Litestar, Router
from litestar.config.compression import CompressionConfig
from litestar.config.cors import CORSConfig
from litestar.connection import Request
from litestar.datastructures import State
from litestar.handlers.http_handlers import HTTPRouteHandler
from litestar.openapi import OpenAPIConfig
from litestar.openapi.plugins import ScalarRenderPlugin
from litestar.plugins.pydantic import PydanticPlugin
from litestar.types import Method, Scope
from litestar.types.internal_types import PathParameterDefinition
from rich import get_console

import shared
from danbooru import DanbooruClient
from db import DB, run_migrations
from db.repositories.posts import PostRepo
from db.repositories.tags import TagGroupRepo, TagRepo
from db.repositories.vectors import VectorRepo
from server.commands import CommandController, ensure_canonical_tag_groups_sync
from server.folders import FoldersController
from server.images import ImageController
from server.posts import PostController
from server.statistics import StatisticsController
from server.tags import TagsController
from utils import initialize, logger, parse_arguments

console = get_console()

with pathlib.Path("pyproject.toml").open("rb") as f:
    pyproject = tomllib.load(f)

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"


@asynccontextmanager
async def my_lifespan(app: Litestar):
    load_dotenv()
    args = parse_arguments()
    initialize(target_dir=args.target_dir)

    db_path_env = os.environ.get("DB_PATH")
    db_path = pathlib.Path(db_path_env) if db_path_env else (shared.pictoria_dir / "pictoria.sqlite")

    logger.info(f"Opening SQLite at {db_path}")
    db = DB(db_path)
    app.state.db = db
    app.state.background_tasks = set()
    # Serialises sync_metadata() so the startup backfill and any manual
    # /v2/cmd/sync-metadata trigger can't race each other on the same pending
    # ids — they would all eventually converge via UPSERT/COALESCE, but the
    # GPU workers would burn cycles re-encoding the same images.
    app.state.backfill_lock = asyncio.Lock()

    try:
        run_migrations(db.cursor(), MIGRATIONS_DIR)

        # One-shot upsert of the five canonical tag groups; cache the resulting
        # name -> id map so every /download-from-danbooru request can skip the
        # five INSERT-then-SELECT round-trips it would otherwise repeat. Also
        # populate ``shared.canonical_tag_groups`` so the backfill workers
        # (which don't see ``app.state``) can read the same cache.
        setup_cur = db.cursor()
        try:
            app.state.canonical_tag_groups = ensure_canonical_tag_groups_sync(setup_cur)
            shared.canonical_tag_groups = app.state.canonical_tag_groups
        finally:
            setup_cur.close()

        # Single long-lived DanbooruClient so httpx keeps the TCP/TLS connection
        # to danbooru.donmai.us alive across tag downloads.
        app.state.danbooru_client = DanbooruClient(
            os.environ.get("DANBOORU_API_KEY", ""),
            os.environ.get("DANBOORU_USER_NAME", ""),
        )

        # Continuously reconcile disk vs DB and run every backfill worker
        # (basics / embedding / tagger / waifu). The first iteration handles
        # files added while the server was offline; subsequent iterations
        # pick up files dropped into target_dir at runtime (e.g. by the
        # /v2/cmd/download-from-danbooru flow, which currently doesn't
        # invoke process_post on its writes). Fire-and-forget so a large
        # initial scan doesn't block the server from accepting requests.
        _spawn_backfill_poller(app, db)

        host = "localhost"
        port = 4777
        doc_url = f"http://{host}:{port}/schema"
        logger.info(f"API Document: {doc_url}")
        yield
    finally:
        await _graceful_shutdown(app, db)


# How long to let in-flight backfill batches finish before we force-cancel
# their asyncio tasks. The slowest single batch we have is "basics" at 32
# images (PIL decode + sha256 + thumbhash); under load that can be ~10 s on
# a cold cache. 30 s gives a comfortable margin without making Ctrl+C feel
# unresponsive.
_BACKFILL_DRAIN_TIMEOUT_S = 30.0

# How often the poller re-runs sync_metadata when no sync is currently in
# flight. The dominant cost of an empty pass is one find_files_in_directory
# walk + four cheap "WHERE … IS NULL" pending queries — both fast enough
# (~seconds) on a 100k-file library that polling every minute is cheap. If
# a sync is still running when the tick fires, this iteration is skipped
# rather than queued, so a long initial scan doesn't pile up backlog.
_BACKFILL_POLL_INTERVAL_S = 60.0


async def _graceful_shutdown(app: Litestar, db: DB) -> None:
    """Tear down the app in a deterministic order.

    Order matters: we ask workers to stop first (so they exit at a batch
    boundary), then we wait for them to actually finish, then we close the
    httpx client, and only *then* close DB connections. Closing DB first
    would race the workers' in-flight writes.
    """
    logger.info("Shutdown: signaling backfill workers to stop at next batch boundary")
    shared.shutdown_event.set()

    tasks = list(getattr(app.state, "background_tasks", ()))
    if tasks:
        logger.info(f"Shutdown: draining {len(tasks)} background task(s) (timeout {_BACKFILL_DRAIN_TIMEOUT_S:.0f}s)")
        done, pending = await asyncio.wait(tasks, timeout=_BACKFILL_DRAIN_TIMEOUT_S)
        if pending:
            logger.warning(f"Shutdown: {len(pending)} task(s) did not finish in time; cancelling")
            for task in pending:
                task.cancel()
            # Wait briefly for cancellation to propagate. The underlying
            # ``asyncio.to_thread`` threads may keep running, but at this
            # point we've given up on letting them finish cleanly.
            await asyncio.gather(*pending, return_exceptions=True)
        # Drain done tasks too so their exceptions get logged rather than
        # turning into "Task exception was never retrieved" warnings.
        for task in done:
            if not task.cancelled() and task.exception() is not None:
                logger.error("Background task crashed during shutdown", exc_info=task.exception())

    danbooru_client = getattr(app.state, "danbooru_client", None)
    if danbooru_client is not None:
        with contextlib.suppress(Exception):
            danbooru_client.client.close()

    with contextlib.suppress(Exception):
        db.close()
    logger.info("Shutdown: complete")


def _spawn_backfill_poller(app: Litestar, db: DB) -> None:
    """Kick off the startup backfill and, separately, a periodic poller.

    These are deliberately two distinct tasks rather than one ``while True``:
    the startup task matches the original "run sync_metadata once on boot"
    behaviour exactly, so its scheduling vs. lifespan-yield ordering is
    unchanged. The poller is a separate task whose first action is
    ``asyncio.sleep`` — that puts its first DB/GPU work strictly after
    lifespan startup completes and the HTTP port opens, so a slow first
    poll can never block the server from coming up.
    """

    async def _run_sync_once(label: str) -> None:
        from processors import sync_metadata  # noqa: PLC0415  # lazy: defer ML stack load

        async with app.state.backfill_lock:
            try:
                await sync_metadata(db)
            except Exception:
                logger.exception(f"{label} metadata sync failed")

    async def _poll_loop() -> None:
        # Sleep BEFORE the first poll so this task doesn't compete with the
        # startup task or with Litestar/uvicorn finishing lifespan startup.
        while not shared.shutdown_event.is_set():
            try:
                await asyncio.sleep(_BACKFILL_POLL_INTERVAL_S)
            except asyncio.CancelledError:
                break
            if shared.shutdown_event.is_set() or app.state.backfill_lock.locked():
                # Either we're shutting down, or the previous iteration is
                # still running (or a manual /v2/cmd/sync-metadata is in
                # flight). Skip this tick — don't queue work behind it.
                continue
            await _run_sync_once("Periodic")

    startup_task = asyncio.create_task(_run_sync_once("Startup"))
    app.state.background_tasks.add(startup_task)
    startup_task.add_done_callback(app.state.background_tasks.discard)

    poll_task = asyncio.create_task(_poll_loop())
    app.state.background_tasks.add(poll_task)
    poll_task.add_done_callback(app.state.background_tasks.discard)


async def provide_post_repo(state: State) -> AsyncGenerator[PostRepo, None]:
    cur = state.db.cursor()
    try:
        yield PostRepo(cur)
    finally:
        cur.close()


async def provide_tag_repo(state: State) -> AsyncGenerator[TagRepo, None]:
    cur = state.db.cursor()
    try:
        yield TagRepo(cur)
    finally:
        cur.close()


async def provide_tag_group_repo(state: State) -> AsyncGenerator[TagGroupRepo, None]:
    cur = state.db.cursor()
    try:
        yield TagGroupRepo(cur)
    finally:
        cur.close()


async def provide_vector_repo(state: State) -> AsyncGenerator[VectorRepo, None]:
    cur = state.db.cursor()
    try:
        yield VectorRepo(cur)
    finally:
        cur.close()


v2 = Router(
    path="/v2",
    route_handlers=[PostController, CommandController, ImageController, TagsController, FoldersController, StatisticsController],
)

SEPARATORS_CLEANUP_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~:]+")


def default_operation_id_creator(
    route_handler: HTTPRouteHandler,
    http_method: Method,
    path_components: list[str | PathParameterDefinition],
) -> str:
    handler_namespace = http_method.title() + route_handler.handler_name.title() if len(route_handler.http_methods) > 1 else route_handler.handler_name.title()
    return SEPARATORS_CLEANUP_PATTERN.sub("", f"{path_components[0]}{handler_namespace}")


cors_config = CORSConfig(allow_origins=["*"])


async def log_unhandled_exception(exc: Exception, scope: Scope) -> None:
    request = Request(scope)
    logger.exception(
        "Unhandled exception in %s %s: %r",
        request.method,
        request.url.path,
        exc,
    )


app = Litestar(
    [v2],
    dependencies={
        "posts": provide_post_repo,
        "tag_repo": provide_tag_repo,
        "tag_group_repo": provide_tag_group_repo,
        "vectors": provide_vector_repo,
    },
    lifespan=[my_lifespan],
    debug=True,
    logging_config=None,
    after_exception=[log_unhandled_exception],
    openapi_config=OpenAPIConfig(
        render_plugins=[ScalarRenderPlugin()],
        title="Pictoria",
        version="0.1.0",
        operation_id_creator=default_operation_id_creator,
        use_handler_docstrings=True,
    ),
    compression_config=CompressionConfig(backend="gzip"),
    plugins=[PydanticPlugin(prefer_alias=True)],
    cors_config=cors_config,
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",  # noqa: S104
        port=4777,
        reload=True,
        reload_dirs=["src"],
        reload_excludes=[".venv"],
        log_config=None,
        # On SIGINT/SIGTERM, stop accepting new connections and give in-flight
        # HTTP requests up to this many seconds to complete before forcing the
        # lifespan shutdown. The lifespan finalizer separately drains backfill
        # workers (see ``_graceful_shutdown``).
        timeout_graceful_shutdown=20,
    )
