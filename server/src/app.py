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
    db_path = pathlib.Path(db_path_env) if db_path_env else (shared.pictoria_dir / "pictoria.duckdb")
    memory_limit = os.environ.get("DUCKDB_MEMORY_LIMIT", "4GB")
    threads = int(os.environ.get("DUCKDB_THREADS", "4"))

    logger.info(f"Opening DuckDB at {db_path}")
    db = DB(db_path, memory_limit=memory_limit, threads=threads)
    run_migrations(db.cursor(), MIGRATIONS_DIR)
    if os.environ.get("REBUILD_HNSW") == "1":
        _rebuild_hnsw_indexes(db)
    app.state.db = db

    # One-shot upsert of the five canonical tag groups; cache the resulting
    # name -> id map so every /download-from-danbooru request can skip the
    # five INSERT-then-SELECT round-trips it would otherwise repeat.
    setup_cur = db.cursor()
    try:
        app.state.canonical_tag_groups = ensure_canonical_tag_groups_sync(setup_cur)
    finally:
        setup_cur.close()

    # Single long-lived DanbooruClient so httpx keeps the TCP/TLS connection
    # to danbooru.donmai.us alive across tag downloads.
    app.state.danbooru_client = DanbooruClient(
        os.environ.get("DANBOORU_API_KEY", ""),
        os.environ.get("DANBOORU_USER_NAME", ""),
    )

    # Backfill metadata + waifu scores for posts added (or partially processed)
    # while the server was offline. Pre-DuckDB-migration `main.py` did this in
    # its lifespan via `await sync_metadata()`; the migration in 983d71a
    # dropped that line. Run as fire-and-forget tasks so a large initial scan
    # doesn't block the server from accepting requests.
    app.state.background_tasks = set()
    _spawn_startup_backfill(app, db)

    host = "localhost"
    port = 4777
    doc_url = f"http://{host}:{port}/schema"
    logger.info(f"API Document: {doc_url}")
    try:
        yield
    finally:
        for task in list(app.state.background_tasks):
            task.cancel()
        app.state.danbooru_client.client.close()
        db.close()


# Each entry: (index_name, table, column, metric). Mirrors migrations/0001_initial.sql.
_HNSW_INDEXES: tuple[tuple[str, str, str, str], ...] = (
    ("hnsw_post_vectors_embedding", "post_vectors", "embedding", "cosine"),
    ("hnsw_posts_dominant_color", "posts", "dominant_color", "l2sq"),
)


def _rebuild_hnsw_indexes(db: DB) -> None:
    """DROP + CREATE the VSS HNSW indexes from underlying table data.

    DuckDB VSS HNSW does not gracefully tolerate DELETE/UPDATE on the
    indexed column — failed inserts can corrupt the on-disk index with
    ghost entries that then fatally invalidate the connection on any
    subsequent write ("Failed to add to the HNSW index: Duplicate keys
    not allowed"). Rebuilding from the underlying table data is the only
    reliable way to clean those ghost entries.

    Gated behind ``REBUILD_HNSW=1`` because the rebuild scans the full
    vector tables — fast for small libraries, but wasteful on every
    startup once writes have been hardened. Set the env var, restart
    once to repair, then unset.
    """
    cur = db.cursor()
    try:
        for name, table, column, metric in _HNSW_INDEXES:
            logger.info(f"Rebuilding HNSW index {name}")
            cur.execute(f"DROP INDEX IF EXISTS {name}")
            cur.execute(
                f"CREATE INDEX {name} ON {table} USING HNSW({column}) "
                f"WITH (metric = '{metric}')",
            )
    finally:
        cur.close()


def _spawn_startup_backfill(app: Litestar, db: DB) -> None:
    """Kick off background metadata + waifu-score backfill on startup."""

    async def _run_metadata_sync() -> None:
        from processors import sync_metadata  # noqa: PLC0415  # lazy: defer ML stack load

        cur_p, cur_v, cur_tg = db.cursor(), db.cursor(), db.cursor()
        try:
            await sync_metadata(PostRepo(cur_p), VectorRepo(cur_v), TagGroupRepo(cur_tg))
        except Exception:
            logger.exception("Startup metadata backfill failed")
        finally:
            for c in (cur_p, cur_v, cur_tg):
                with contextlib.suppress(Exception):
                    c.close()

    async def _run_waifu_score_backfill() -> None:
        from services.waifu import waifu_score_all_posts  # noqa: PLC0415  # lazy: defer ML stack load

        cur = db.cursor()
        try:
            await waifu_score_all_posts(PostRepo(cur))
        except Exception:
            logger.exception("Startup waifu-score backfill failed")
        finally:
            with contextlib.suppress(Exception):
                cur.close()

    for coro in (_run_metadata_sync(), _run_waifu_score_backfill()):
        task = asyncio.create_task(coro)
        app.state.background_tasks.add(task)
        task.add_done_callback(app.state.background_tasks.discard)


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

    uvicorn.run("app:app", host="0.0.0.0", port=4777, reload=True, reload_dirs=["src"], reload_excludes=[".venv"], log_config=None)  # noqa: S104
